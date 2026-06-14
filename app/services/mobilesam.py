"""MobileSAM (ONNX, CPU) mask refiner.

Layered ON TOP of Gemini's detection: Gemini finds and labels the damaged parts
and returns rough boxes; this module turns each box into a pixel-accurate mask via
MobileSAM's lightweight ONNX encoder+decoder running on CPU (onnxruntime), then
tightens the bounding box to the mask.

Everything here is best-effort and OFF by default. If the model can't be loaded or
inference fails, the caller keeps Gemini's original boxes — the app never breaks.

Model files are NOT bundled; set MOBILESAM_ONNX_REPO (a HuggingFace repo holding the
encoder/decoder ONNX files) plus MOBILESAM_ENCODER_FILE / MOBILESAM_DECODER_FILE.
Targets the standard segment-anything ONNX decoder I/O convention.
"""
from __future__ import annotations

import base64
import io
import logging
from pathlib import Path

import numpy as np
from PIL import Image

from app.core.config import (
    MOBILESAM_DECODER_FILE,
    MOBILESAM_ENCODER_FILE,
    MOBILESAM_ONNX_REPO,
)
from app.models.schemas import BoundingBox, DamageRegion

logger = logging.getLogger("claimsight.mobilesam")

_TARGET = 1024
_PIXEL_MEAN = np.array([123.675, 116.28, 103.53], dtype=np.float32)
_PIXEL_STD = np.array([58.395, 57.12, 57.375], dtype=np.float32)
# Mask fill color by severity (matches the UI palette).
_SEVERITY_RGB = {
    "high": (224, 92, 74),
    "moderate": (240, 180, 41),
    "low": (167, 227, 74),
}


class MobileSamRefiner:
    def __init__(self) -> None:
        self._encoder = None
        self._decoder = None
        self._load_error: str | None = None
        self._load()

    @property
    def ready(self) -> bool:
        return self._encoder is not None and self._decoder is not None

    @property
    def load_error(self) -> str | None:
        return self._load_error

    def _load(self) -> None:
        if not MOBILESAM_ONNX_REPO:
            self._load_error = "MOBILESAM_ONNX_REPO not set"
            logger.warning("MobileSAM disabled: %s", self._load_error)
            return
        try:
            import onnxruntime as ort
            from huggingface_hub import hf_hub_download

            enc_path = hf_hub_download(MOBILESAM_ONNX_REPO, MOBILESAM_ENCODER_FILE)
            dec_path = hf_hub_download(MOBILESAM_ONNX_REPO, MOBILESAM_DECODER_FILE)
            opts = ort.SessionOptions()
            opts.intra_op_num_threads = 2
            self._encoder = ort.InferenceSession(enc_path, sess_options=opts, providers=["CPUExecutionProvider"])
            self._decoder = ort.InferenceSession(dec_path, sess_options=opts, providers=["CPUExecutionProvider"])
            logger.warning("MobileSAM ONNX loaded from %s", MOBILESAM_ONNX_REPO)
        except Exception as exc:  # pragma: no cover - depends on external model
            self._load_error = str(exc)
            self._encoder = None
            self._decoder = None
            logger.warning("MobileSAM failed to load, will keep Gemini boxes: %s", exc)

    def refine_image(self, image_path: Path, regions: list[DamageRegion]) -> None:
        """Tighten each region's bounding box to its MobileSAM mask, in place.

        Only touches regions whose image_index points at this image. No-op on any error.
        """
        if not self.ready or not regions:
            return
        try:
            with Image.open(image_path) as img:
                rgb = np.array(img.convert("RGB"))
            embedding, scale, orig_hw = self._encode(rgb)
            if embedding is None:
                return
            for region in regions:
                mask = self._mask_for_box(embedding, scale, orig_hw, region.bounding_box)
                if mask is None:
                    continue
                refined = self._bbox_from_mask(mask)
                if refined is None:
                    continue
                region.bounding_box = refined
                region.source = "gemini+sam2"
                # Cropped, colored mask PNG positioned later at the (refined) box.
                region.mask_png = self._mask_png(mask, refined, region.severity)
        except Exception as exc:
            logger.warning("MobileSAM refine failed, keeping Gemini boxes: %s", exc)

    def _encode(self, rgb: np.ndarray):
        h, w = rgb.shape[:2]
        scale = _TARGET / max(h, w)
        new_h, new_w = round(h * scale), round(w * scale)
        resized = np.array(
            Image.fromarray(rgb).resize((new_w, new_h), Image.BILINEAR), dtype=np.float32
        )
        normalized = (resized - _PIXEL_MEAN) / _PIXEL_STD
        padded = np.zeros((_TARGET, _TARGET, 3), dtype=np.float32)
        padded[:new_h, :new_w, :] = normalized
        tensor = np.transpose(padded, (2, 0, 1))[None, :, :, :].astype(np.float32)

        enc_in = self._encoder.get_inputs()[0].name
        out = self._encoder.run(None, {enc_in: tensor})
        return out[0], scale, (h, w)

    def _mask_for_box(self, embedding, scale, orig_hw, box: BoundingBox):
        """Run the decoder with a box prompt; return a full-size boolean mask or None."""
        h, w = orig_hw
        # Box corners in the resized (1024) coordinate frame, SAM box-prompt labels 2/3.
        coords = np.array(
            [[[box.x * scale, box.y * scale], [(box.x + box.width) * scale, (box.y + box.height) * scale]]],
            dtype=np.float32,
        )
        labels = np.array([[2, 3]], dtype=np.float32)
        feeds = {
            "image_embeddings": embedding.astype(np.float32),
            "point_coords": coords,
            "point_labels": labels,
            "mask_input": np.zeros((1, 1, 256, 256), dtype=np.float32),
            "has_mask_input": np.zeros((1,), dtype=np.float32),
            "orig_im_size": np.array([h, w], dtype=np.float32),
        }
        # Only pass inputs the decoder actually declares (export variants differ).
        decl = {i.name for i in self._decoder.get_inputs()}
        feeds = {k: v for k, v in feeds.items() if k in decl}
        if "image_embeddings" not in feeds:
            return None

        outputs = self._decoder.run(None, feeds)
        mask = np.asarray(outputs[0])
        while mask.ndim > 2:
            mask = mask[0]
        return mask > 0.0

    def _bbox_from_mask(self, mask: np.ndarray):
        ys, xs = np.where(mask)
        if ys.size == 0:
            return None
        left, right = int(xs.min()), int(xs.max())
        top, bottom = int(ys.min()), int(ys.max())
        return BoundingBox(
            x=max(0, left),
            y=max(0, top),
            width=max(1, right - left),
            height=max(1, bottom - top),
        )

    def _mask_png(self, mask: np.ndarray, box: BoundingBox, severity: str) -> str:
        """Crop the mask to its box and return a translucent colored PNG data URL.

        The crop aligns exactly with the (refined) bounding box, so the frontend can
        draw it at the same screen rect it uses for the box.
        """
        try:
            crop = mask[box.y : box.y + box.height, box.x : box.x + box.width]
            if crop.size == 0:
                return ""
            r, g, b = _SEVERITY_RGB.get(severity, _SEVERITY_RGB["moderate"])
            h, w = crop.shape
            rgba = np.zeros((h, w, 4), dtype=np.uint8)
            rgba[crop, 0] = r
            rgba[crop, 1] = g
            rgba[crop, 2] = b
            rgba[crop, 3] = 110  # translucent fill
            img = Image.fromarray(rgba, mode="RGBA")
            # Keep payload small.
            if max(h, w) > 256:
                ratio = 256 / max(h, w)
                img = img.resize((max(1, int(w * ratio)), max(1, int(h * ratio))), Image.NEAREST)
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
        except Exception as exc:
            logger.warning("mask PNG build failed: %s", exc)
            return ""
