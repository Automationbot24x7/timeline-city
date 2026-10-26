# Earth at night textures

**Credit line (on screen while the globe is visible):**
Earth at night: NASA Earth Observatory (Black Marble)

Source: NASA Earth Observatory, "Earth at Night" / Black Marble 2016 colour maps (image record 144898),
a cloud-free composite of Suomi NPP VIIRS night-time imagery. NASA imagery is not copyrighted
(see https://www.nasa.gov/nasa-brand-center/). No NASA logo or endorsement is implied.

- Collection page: https://science.nasa.gov/earth/earth-observatory/earth-at-night/maps
  (the old https://earthobservatory.nasa.gov/images/144898/earth-at-night and visibleearth.nasa.gov links redirect there)
- Files downloaded 2026-10-25:

| downloaded file | URL | size | sha256 |
|---|---|---|---|
| BlackMarble_2016_3km.jpg (13500 x 6750, global, 3 km) | https://eoimages.gsfc.nasa.gov/images/imagerecords/144000/144898/BlackMarble_2016_3km.jpg | 8,106,233 B | 230aac448ae68c358be433dd518888cccb3a85ccf66f7b44326441c324ad6725 |
| BlackMarble_2016_C1.jpg (21600 x 21600, 500 m tile C1 = 0-90 E, 0-90 N, 15 arc-sec) | https://eoimages.gsfc.nasa.gov/images/imagerecords/144000/144898/BlackMarble_2016_C1.jpg | 59,097,456 B | 446fcc72755ebc3625f96d39f2bcb247016038b74c90c655a65991e6de71b3b5 |

(The same files are mirrored under https://assets.science.nasa.gov/content/dam/science/esd/eo/images/imagerecords/144000/144898/.)

## Derived files (this folder, 6.4 MB total)

| file | made from | how | sha256 |
|---|---|---|---|
| earth_night_8k.jpg (8192 x 4096, equirectangular, whole globe) | BlackMarble_2016_3km.jpg | ffmpeg `scale=8192:4096:flags=lanczos`, `-q:v 2` | 458723666621710f1251ad26bc8b76b0960fd4b333cd625f4b39e9e94889ea7d |
| earth_night_south_asia.jpg (3600 x 3840; 60-90 E, 5-37 N; ~1 km/px; 2,184,385 B) | tile C1 | `python derive_night_textures.py <dir with the C1 tile>`: crop, Lanczos 1/2, thin isolated lines of light replaced by the land beside them (below), JPEG q90 (Pillow 12.2, numpy 2.5) | fedd1bf459925b17377c908218c32d9cef8c312449b74054220efb72f5f5333b |
| earth_night_delhi.jpg (1440 x 1440; 74.2-80.2 E, 25.6-31.6 N; 500 m/px) | tile C1 | crop, full resolution, JPEG q92 (Pillow) | 5a1a30eae51192b934320e2a21c4ae4c6fc7d4489ba46910a7c54be8cee69b5f |

(earth_night_south_asia.jpg before 2026-10-26: plain crop + Lanczos 1/2, sha256 344d5854...3a24ca.)

Crop bounds are listed in `render/three/globe.js` (`EARTH_PATCHES`); a patch is only loaded when it contains the
film's target. The images contain no borders or place names, and the globe draws none.

**No border by implication either.** VIIRS sees floodlit border fences: at ~1 km the India-Pakistan fence across
the Thar and the Rann is a bright wiggly line of light. `derive_night_textures.py` replaces every thin, isolated
line of light in sparsely lit country with the land beside it, by shape alone (no boundary data is used; lit
highways across empty desert go too; villages, towns and roads among dense lights stay; regional light totals
change by 2-10 %). In earth_night_8k.jpg the fence is a faint sub-pixel line that the globe's light curve drops
(its brightest pixel maps to < 0.1 % of a city core), and earth_night_delhi.jpg shows no distinct fence line.

**Moonlit land.** These colour maps already carry the land surface as a dim blue layer under the lights (relief,
deserts, snow and ice, lakes). The globe separates that layer from the lights by colour and shades it as moonlit
land (slate, paler deserts, silver snow), so every land surface reads as land at night and the lights read as
points on it, never as a lit silhouette. No other imagery is used, so the credit line above covers it.

In the last stretch of the dive the globe also draws the project's own OpenStreetMap layers from geo.json
(roads, water, green, the ridden line): "Map data © OpenStreetMap contributors (ODbL)", already on screen in the film.
