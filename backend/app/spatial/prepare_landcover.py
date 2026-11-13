"""Create the small spatial raster display preview without editing the source."""

import os

import rasterio
from rasterio.enums import Resampling

from . import config
from .raster import overview_path, source_signature


def prepare():
    if not config.LANDCOVER_PATH.is_file():
        print("Land-cover source absent; map will report this layer unavailable.")
        return None
    signature = source_signature()
    target = overview_path(signature)
    if target.is_file():
        print(f"Land-cover display preview ready: {target.name}")
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(f".{os.getpid()}.tmp.tif")
    print("Preparing the spatial land-cover display preview; source TIFF remains unchanged.", flush=True)
    try:
        with rasterio.Env(GDAL_CACHEMAX=64 * 1024 * 1024):
            with rasterio.open(config.LANDCOVER_PATH) as source:
                width = min(3072, source.width)
                height = max(1, round(source.height * width / source.width))
                pixels = source.read(1, out_shape=(height, width), resampling=Resampling.nearest)
                transform = source.transform * source.transform.scale(source.width / width, source.height / height)
                with rasterio.open(temporary, "w", driver="GTiff", width=width, height=height, count=1, dtype="uint8", crs=source.crs, transform=transform, nodata=0, compress="deflate", tiled=True, blockxsize=256, blockysize=256) as destination:
                    destination.write(pixels, 1)
                    destination.write_colormap(1, source.colormap(1))
                    destination.update_tags(purpose="Nearest-neighbour display preview only. Not suitable for area statistics.")
        temporary.replace(target)
    finally:
        if temporary.is_file():
            temporary.unlink()
    print(f"Spatial raster preview ready: {target.stat().st_size / 1e6:.2f} MB", flush=True)
    return target


if __name__ == "__main__":
    prepare()
