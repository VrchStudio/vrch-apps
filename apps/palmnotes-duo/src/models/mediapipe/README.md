# Landmark models

- Hand: `hand_landmarker-float16-v1.task` — SHA-256 `fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1`
- Hand Lite: `hand_landmarker-lite-v1.task` — SHA-256 `4a347966d82430874f6fb7a72b76bbf2df3eba4066323d907a491ea82e94c5c4`
- Face: `face_landmarker-float16-v1.task` — SHA-256 `64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff`
- Face Lite (retained but not used): `face_landmarker-lite-v1.task` — SHA-256 `2261776d8bb2d017fcd6e8cd152712d9218ba7184f3cc3038691a0675f3137a5`. Its output order is not compatible with the Tasks Face Landmarker topology.
- Pose Lite: `pose_landmarker-lite-float16-v1.task` — SHA-256 `59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a`

The original Hand, Face, and Pose bundles are official MediaPipe Tasks Vision
float16 bundles from `storage.googleapis.com/mediapipe-models`. Hand Lite keeps
the official task detector/metadata assets and packages MediaPipe's Apache-2.0
lite landmark model under the same Tasks asset names. Face Lite is retained for
forensics only and is not selected by the runtime because its landmark ordering
differs.
All models are served from the same Pages origin. The runtime performs no model
download after deployment and does not fall back to a CDN.
