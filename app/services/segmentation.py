from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path

import numpy as np
from PIL import Image, ImageStat

from app.core.config import ENABLE_SAM2_ONNX, SEGMENTATION_PROVIDER
from app.models.schemas import BoundingBox, ClaimContext, DamageRegion


class SegmentationService(ABC):
    @abstractmethod
    def analyze(self, image_path: Path, original_filename: str) -> list[DamageRegion]:
        raise NotImplementedError

    def analyze_images(
        self,
        image_paths: list[Path],
        original_filenames: list[str],
        claim_context: ClaimContext | None = None,
    ) -> list[DamageRegion]:
        """Multi-image entry point.

        Default implementation only inspects the first image (providers that can't
        reason across angles). Gemini overrides this to analyze all images at once.
        """
        return self.analyze(image_paths[0], original_filenames[0])

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


class GeminiSegmentationService(SegmentationService):
    """Uses Gemini's multimodal grounding to detect real damage regions.

    Falls back to the classical detector if Gemini is unavailable or returns nothing usable.
    """

    def __init__(self) -> None:
        from app.services.gemini_client import GeminiClaimNarrator

        self._narrator = GeminiClaimNarrator()
        self._fallback = ClassicalSegmentationService()

        # Optional MobileSAM (ONNX, CPU) mask refiner — layered on Gemini's boxes.
        self._refiner = None
        if ENABLE_SAM2_ONNX:
            try:
                from app.services.mobilesam import MobileSamRefiner

                self._refiner = MobileSamRefiner()
            except Exception:
                self._refiner = None

    @property
    def narrator(self):
        """Underlying Gemini client, or None when it isn't configured.

        The self-correction loop uses this to re-run a single stage.
        """
        return self._narrator if self._narrator.enabled else None

    @property
    def provider_name(self) -> str:
        if not self._narrator.enabled:
            return self._fallback.provider_name
        if self._refiner is not None and self._refiner.ready:
            return "gemini+sam2"
        return "gemini"

    def analyze(self, image_path: Path, original_filename: str) -> list[DamageRegion]:
        return self.analyze_images([image_path], [original_filename])

    def analyze_images(
        self,
        image_paths: list[Path],
        original_filenames: list[str],
        claim_context: ClaimContext | None = None,
    ) -> list[DamageRegion]:
        regions = self._narrator.detect_regions(image_paths, original_filenames, claim_context)
        # detect_regions returns:
        #   None  -> Gemini errored/unavailable -> fall back to the classical detector
        #   []    -> Gemini ran and found no damage -> return no regions (do NOT hallucinate)
        #   [...] -> real detections
        if regions is None:
            # Fallback can only inspect a single image; use the first.
            return self._fallback.analyze(image_paths[0], original_filenames[0])

        # Refine each detected box into a tight MobileSAM mask box (best-effort).
        if regions and self._refiner is not None and self._refiner.ready:
            for index, path in enumerate(image_paths):
                in_image = [r for r in regions if (r.image_index or 0) == index]
                if in_image:
                    self._refiner.refine_image(path, in_image)

        return regions


def get_segmentation_service() -> SegmentationService:
    if SEGMENTATION_PROVIDER == "mock":
        return MockSegmentationService()
    if SEGMENTATION_PROVIDER == "classical":
        return ClassicalSegmentationService()
    # Gemini is the default provider; unknown values fall back to it rather than
    # to a heavyweight local model.
    return GeminiSegmentationService()
