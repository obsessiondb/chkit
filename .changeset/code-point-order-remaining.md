---
"chkit": patch
---

`pull`, `drift`, `migrate`, the generated `runMigrations` module and the plugin and ObsessionDB alias lists now order names that contain characters outside the Basic Multilingual Plane (such as emoji) by code point, the same as chkit-py (#703).
