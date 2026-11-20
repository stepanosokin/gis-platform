from osgeo import gdal, osr


gdal.UseExceptions()
dataset = gdal.GetDriverByName("GTiff").Create("/results/map-control.tif", 40, 40, 3, gdal.GDT_Byte)
dataset.SetGeoTransform((10, 0.1, 0, 24, 0, -0.1))
crs = osr.SpatialReference()
crs.ImportFromEPSG(4326)
dataset.SetSpatialRef(crs)
colors = ((255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 0))
for band in range(3):
    data = bytes(colors[(y // 20) * 2 + x // 20][band] for y in range(40) for x in range(40))
    dataset.GetRasterBand(band + 1).WriteRaster(0, 0, 40, 40, data)
dataset = None
projected = gdal.Warp("", "/results/map-control.tif", format="MEM", dstSRS="EPSG:3857")
gdal.Translate("/results/map-control.cog.tiff", projected, format="COG")
