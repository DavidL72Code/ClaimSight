from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path

import numpy as np
from PIL import Image, ImageStat

from app.core.config import SAM2_MODEL_ID, SEGMENTATION_PROVIDER
from app.models.schemas import BoundingBox, DamageRegion


class SegmentationService(ABC):
    @abstractmethod
    def analyze(self, image_path: Path, original_filename: str) -> list[DamageRegion]:
        raise NotImplementedError

    @property
    @abstractmethod
    def provider_name(self) -> str:
        raise NotImplementedError


class MockSegmentationService(SegmentationService):
    """Deterministic fallback for demos and tests."""

    @property
    def provider_name(self) -> str:
        return "mock"

    def analyze(self, image_path: Path, original_filename: str) -> list[DamageRegion]:
        seed = len(original_filename) % 3

        presets = [
            [
                DamageRegion(
                    panel="front bumper",
                    damage_type="dent",
                    severity="moderate",
                    confidence=0.91,
                    bounding_box=BoundingBox(x=86, y=220, width=210, height=115),
                    estimated_repair_cost_usd=1200,
                    source=self.provider_name,
                ),
                DamageRegion(
                    panel="left headlight",
                    damage_type="crack",
                    severity="high",
                    confidence=0.88,
                    bounding_box=BoundingBox(x=58, y=160, width=95, height=80),
                    estimated_repair_cost_usd=650,
                    source=self.provider_name,
                ),
            ],
            [
                DamageRegion(
                    panel="rear door",
                    damage_type="scratch",
                    severity="low",
                    confidence=0.93,
                    bounding_box=BoundingBox(x=240, y=170, width=170, height=120),
                    estimated_repair_cost_usd=500,
                    source=self.provider_name,
                ),
                DamageRegion(
                    panel="rear quarter panel",
                    damage_type="dent",
                    severity="moderate",
                    confidence=0.87,
                    bounding_box=BoundingBox(x=410, y=155, width=145, height=135),
                    estimated_repair_cost_usd=950,
                    source=self.provider_name,
                ),
            ],
            [
                DamageRegion(
                    panel="hood",
                    damage_type="hail impact",
                    severity="moderate",
                    confidence=0.89,
                    bounding_box=BoundingBox(x=190, y=110, width=260, height=150),
                    estimated_repair_cost_usd=1400,
                    source=self.provider_name,
                ),
            ],
        ]

        return presets[seed]


class ClassicalSegmentationService(SegmentationService):
    """
    Lightweight damage candidate detector.

    This produces box prompts for SAM 2 and acts as a fallback when the learned model is not
    available in the local environment.
    """

    @property
    def provider_name(self) -> str:
        return "classical-cv"

    def analyze(self, image_path: Path, original_filename: str) -> list[DamageRegion]:
        with Image.open(image_path) as image:
            rgb = image.convert("RGB")
            width, height = rgb.size
            tiles_x = 3
            tiles_y = 3
            tile_width = max(width // tiles_x, 1)
            tile_height = max(height // tiles_y, 1)
            average_brightness = float(ImageStat.Stat(rgb.convert("L")).mean[0])

            candidates: list[tuple[float, int, int, int, int, float]] = []

            for row in range(tiles_y):
                for col in range(tiles_x):
                    left = col * tile_width
                    top = row * tile_height
                    right = width if col == tiles_x - 1 else (col + 1) * tile_width
                    bottom = height if row == tiles_y - 1 else (row + 1) * tile_height

                    tile = rgb.crop((left, top, right, bottom))
                    r_mean, g_mean, b_mean = ImageStat.Stat(tile).mean
                    brightness = (r_mean + g_mean + b_mean) / 3
                    spread = max(r_mean, g_mean, b_mean) - min(r_mean, g_mean, b_mean)
                    score = abs(brightness - average_brightness) + (spread * 0.6)

                    candidates.append((score, left, top, right, bottom, brightness))

        top_regions = sorted(candidates, key=lambda item: item[0], reverse=True)[:2]
        if not top_regions:
            return MockSegmentationService().analyze(image_path, original_filename)

        return self._regions_from_candidates(top_regions, width, height, self.provider_name)

    def candidate_boxes(self, image_path: Path) -> list[tuple[int, int, int, int]]:
        return [
            (
                region.bounding_box.x,
                region.bounding_box.y,
                region.bounding_box.x + region.bounding_box.width,
                region.bounding_box.y + region.bounding_box.height,
            )
            for region in self.analyze(image_path, image_path.name)
        ]

    def _regions_from_candidates(
        self,
        top_regions: list[tuple[float, int, int, int, int, float]],
        width: int,
        height: int,
        source: str,
    ) -> list[DamageRegion]:
        results: list[DamageRegion] = []
        labels = self._panel_labels(width, height)
        for index, (score, left, top, right, bottom, brightness) in enumerate(top_regions):
            panel = labels[index]
            damage_type, severity, cost = self._damage_profile(score, brightness)
            confidence = min(0.98, 0.62 + (score / 255))
            results.append(
                DamageRegion(
                    panel=panel,
                    damage_type=damage_type,
                    severity=severity,
                    confidence=round(confidence, 2),
                    bounding_box=BoundingBox(
                        x=int(left),
                        y=int(top),
                        width=int(right - left),
                        height=int(bottom - top),
                    ),
                    estimated_repair_cost_usd=cost,
                    source=source,
                )
            )
        return results

    def _damage_profile(self, score: float, brightness: float) -> tuple[str, str, int]:
        if score > 95:
            return ("crumple or crack", "high", 2800 if brightness < 90 else 2200)
        if score > 60:
            return ("dent", "moderate", 1350)
        return ("scratch", "low", 550)

    def _panel_labels(self, width: int, height: int) -> list[str]:
        if width >= height:
            return ["side panel", "bumper"]
        return ["hood", "front fascia"]


class Sam2SegmentationService(SegmentationService):
    """
    SAM 2 image segmentation adapter.

    The model is prompted from candidate boxes produced by the classical detector. This mirrors the
    documented `SAM2ImagePredictor(...).set_image(...); predict(<input_prompts>)` workflow from the
    official repository, with box prompts inferred for this application.
    """

    def __init__(self) -> None:
        self._classical = ClassicalSegmentationService()
        self._predictor = None
        self._load_error: str | None = None
        self._load_predictor()

    @property
    def provider_name(self) -> str:
        return "sam2"

    @property
    def ready(self) -> bool:
        return self._predictor is not None

    @property
    def load_error(self) -> str | None:
        return self._load_error

    def analyze(self, image_path: Path, original_filename: str) -> list[DamageRegion]:
        seed_regions = self._classical.analyze(image_path, original_filename)
        if not self.ready:
            return seed_regions

        try:
            with Image.open(image_path) as image:
                rgb = image.convert("RGB")
                image_array = np.array(rgb)
                self._predictor.set_image(image_array)
                refined: list[DamageRegion] = []

                for region in seed_regions:
                    box = np.array(
                        [
                            region.bounding_box.x,
                            region.bounding_box.y,
                            region.bounding_box.x + region.bounding_box.width,
                            region.bounding_box.y + region.bounding_box.height,
                        ],
                        dtype=np.float32,
                    )
                    mask = self._predict_mask(box)
                    if mask is None:
                        refined.append(region)
                        continue

                    bbox = self._bounding_box_from_mask(mask)
                    if bbox is None:
                        refined.append(region)
                        continue

                    refined.append(
                        DamageRegion(
                            panel=region.panel,
                            damage_type=region.damage_type,
                            severity=region.severity,
                            confidence=max(region.confidence, 0.8),
                            bounding_box=bbox,
                            estimated_repair_cost_usd=region.estimated_repair_cost_usd,
                            source=self.provider_name,
                        )
                    )

                return refined or seed_regions
        except Exception:
            return seed_regions

    def _load_predictor(self) -> None:
        try:
            from sam2.sam2_image_predictor import SAM2ImagePredictor

            self._predictor = SAM2ImagePredictor.from_pretrained(SAM2_MODEL_ID)
        except Exception as exc:
            self._load_error = str(exc)
            self._predictor = None

    def _predict_mask(self, box: np.ndarray) -> np.ndarray | None:
        attempts = [
            {"box": box, "multimask_output": False},
            {"box": box[None, :], "multimask_output": False},
        ]

        for kwargs in attempts:
            try:
                masks, _, _ = self._predictor.predict(**kwargs)
                if masks is None:
                    continue
                mask_array = np.asarray(masks)
                if mask_array.ndim == 3:
                    return mask_array[0]
                if mask_array.ndim == 2:
                    return mask_array
            except TypeError:
                continue
            except Exception:
                return None
        return None

    def _bounding_box_from_mask(self, mask: np.ndarray) -> BoundingBox | None:
        coords = np.argwhere(mask > 0)
        if coords.size == 0:
            return None
        top = int(coords[:, 0].min())
        bottom = int(coords[:, 0].max())
        left = int(coords[:, 1].min())
        right = int(coords[:, 1].max())
        return BoundingBox(
            x=left,
            y=top,
            width=max(1, right - left + 1),
            height=max(1, bottom - top + 1),
        )


class GeminiSegmentationService(SegmentationService):
    """Uses Gemini's multimodal grounding to detect real damage regions.

    Falls back to the classical detector if Gemini is unavailable or returns nothing usable.
    """

    def __init__(self) -> None:
        from app.services.gemini_client import GeminiClaimNarrator

        self._narrator = GeminiClaimNarrator()
        self._fallback = ClassicalSegmentationService()

    @property
    def provider_name(self) -> str:
        return "gemini" if self._narrator.enabled else self._fallback.provider_name

    def analyze(self, image_path: Path, original_filename: str) -> list[DamageRegion]:
        regions = self._narrator.detect_regions(image_path, original_filename)
        if regions:
            return regions
        return self._fallback.analyze(image_path, original_filename)


def get_segmentation_service() -> SegmentationService:
    if SEGMENTATION_PROVIDER == "mock":
        return MockSegmentationService()
    if SEGMENTATION_PROVIDER == "classical":
        return ClassicalSegmentationService()
    if SEGMENTATION_PROVIDER == "gemini":
        return GeminiSegmentationService()
    return Sam2SegmentationService()
