# Runtime asset sources

All external runtime assets below are CC0/public domain. Original files are kept in `assets/source/`; trimmed/filtered runtime audio is in `public/audio/`.

| Runtime asset                  | Creator / source                                                                                   | License and adaptation                                                                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `naval-gun.wav`                | qubodup, [MK 45 Gun Fired](https://freesound.org/people/qubodup/sounds/184728/)                    | CC0. Source identifies an actual US-government naval-gun recording. First shot trimmed to 1.9 s, high-pass at 28 Hz, fade and peak limiting. |
| `heavy-cannon.wav`             | Thimras, [Cannon fire](https://opengameart.org/content/cannon-fire)                                | CC0. High-pass at 25 Hz and peak limiting.                                                                                                   |
| `distant-boom.wav`             | NenadSimic, [Muffled Distant Explosion](https://opengameart.org/content/muffled-distant-explosion) | CC0. High-pass at 25 Hz and peak limiting.                                                                                                   |
| `rocky_terrain_*`              | Amal Kumar / [Poly Haven](https://polyhaven.com/a/rocky_terrain)                                   | CC0, 1K diffuse and OpenGL normal.                                                                                                           |
| `coast_sand_01_diff.jpg`       | Rob Tuytel / [Poly Haven](https://polyhaven.com/a/coast_sand_01)                                   | CC0, 1K diffuse.                                                                                                                             |
| `coast_land_rocks_01_diff.jpg` | [Poly Haven](https://polyhaven.com/a/coast_land_rocks_01)                                          | CC0, 1K diffuse.                                                                                                                             |
| `aerial_grass_rock_diff.jpg`   | [Poly Haven](https://polyhaven.com/a/aerial_grass_rock)                                            | CC0, 1K diffuse.                                                                                                                             |
| `metal_plate_02_*`             | Rob Tuytel / [Poly Haven](https://polyhaven.com/a/metal_plate_02)                                  | CC0, 1K diffuse and OpenGL normal, weathering blended with naval paint.                                                                      |
| `wood_planks_diff.jpg`         | [Poly Haven](https://polyhaven.com/a/wood_planks)                                                  | CC0, 1K diffuse.                                                                                                                             |

Additional CC0 recordings added on 2026-10-18:

| Runtime asset          | Creator / source                                                                                                 | Adaptation                                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `engine-loop.wav`      | monotraum, [ship engine.wav](https://freesound.org/people/monotraum/sounds/253606/)                              | 14 s excerpt of HQ MP3 preview, 32 kHz WAV, high/low-pass and loudness normalization; runtime crossfade at loop boundary. |
| `wake-loop.wav`        | Pfannkuchn, [Sailing boat, bow wave (close perspective)](https://freesound.org/people/Pfannkuchn/sounds/360631/) | 16 s excerpt of HQ MP3 preview, 32 kHz WAV, high/low-pass and normalization; runtime crossfade.                           |
| `torpedo-pressure.wav` | mcpable, [Slips air release v4](https://freesound.org/people/mcpable/sounds/131931/)                             | Industrial pressure-release Foley, filtered and normalized HQ preview; not an actual torpedo recording.                   |
| `torpedo-splash.wav`   | qubodup, [Big Water Splash](https://freesound.org/people/qubodup/sounds/442773/)                                 | CC0 composite splash Foley, resampled and normalized HQ preview.                                                          |

Poly Haven's [asset license](https://polyhaven.com/license) permits modification and redistribution under CC0. Runtime assets are served locally; the game does not fetch third-party asset servers.

## User-supplied NPC model

`public/models/npc-battleship.glb` is an unchanged copy of the user-provided `Meshy_AI_Camouflaged_Battleshi_1017161035_texture.glb`, integrated at the user's explicit request. SHA-256: `1f49b0a0fa22b61c3e40ef91eb57bcf9ea103970e6b10d5bdace0b31288265ed`. It is not included in the CC0 statement above. Source GLB has a single mesh and no independently animated turrets. Runtime code rotates -X bow to +Z, scales to each NPC hull class, sets waterline and adds independently animated main-battery turrets. Human players retain the original game models.

`public/models/npc-wisconsin-golden.glb` is an unchanged copy of the user-provided `Meshy_AI_Golden_Leviathan_1017162031_texture.glb`. SHA-256: `fafea386e31f0dfcf75ffa5537ed00d1ddd9079f2b9a65aafd628a18d4503b03`. It is also user-supplied, not CC0 content. Bow and waterline are normalized separately from the camouflage model. The NPC variant is named Wisconsin Golden and adds three rotating triple 406 mm gun turrets. Its gun arrangement follows [Wisconsin's official game description](https://wiki.worldofwarships.com/Ship:Update_13.3) and the [Wisconsin Golden entry](https://na.wows-numbers.com/ship/3309254640,Wisconsin-Golden/), matching the ID in the user's [Asia reference](https://asia.wows-numbers.com/ko/ship/3309254640,Wisconsin-Golden/). Other combat balance values use this game's existing battleship rules.

## Korean radio speech

`public/audio/radio/*.wav` contains 12 computer-generated Korean male orders using `ko-KR-InJoonNeural` from Microsoft's online speech service, downloaded during asset preparation through [edge-tts](https://github.com/rany2/edge-tts), version 7.3.1. This replaces the mechanical macOS Reed draft. The current voice is lightly band-limited to 250–3400 Hz and compressed at 2.5:1, with low-level generated radio static and opening/closing squelch. Heavy saturation is removed. These are synthetic spoken lines, not recordings of actors or real military radio traffic, and are separate from the CC0 field recordings above. `python3 scripts/build-radio.py` rebuilds the clips with uv, FFmpeg and network access; MP3 sources are cached in `assets/source/radio-neural/`. The game plays bundled WAVs; no runtime speech API, OS voice or external service is required.

Human ship meshes, added turret assemblies, terrain generation, combat particle textures and wake masks are original code-native assets. The two NPC GLB hulls are the user-supplied models described above. The game models are artistic representations, not exact scale replicas of historic ships.

Cached source-page HTML under `assets/source/` retains attribution evidence; embedded third-party Mapbox access tokens are redacted and are not used by the game.
