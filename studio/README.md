# Layout Studio

`layout-studio.html` is the source of the Home Hub Layout Studio artifact
(https://claude.ai/artifact/JtD3vYbeiscHxDfKCyc7BH). It is not loaded by the
TV. It is kept here so the page and the TV code can be changed together.

The "What shows at each size" section is driven by one object in the page,
`SIZE_MATRIX`. `docs/tile-sizes.md` is the same table in English. When a
widget's tile changes what it draws at a size, update both.
