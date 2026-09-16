# Music Factory project guidance

Read `README-RU.md` and `WINDOWS-CODEX-HANDOFF.md` before changing this project.

This is a local Electron application for a personal music workflow. Preserve user audio, JSON queues, account assignment, and existing state. Never delete user data or run a real SoundCloud upload/monetization submission as a test. Browser automation must stop on CAPTCHA, payment, subscription, rights, identity, or unfamiliar forms.

Use Node's built-in test runner through `npm test`. Keep macOS Apple Silicon and native Windows x64 behavior compatible. ACE-Step 1.5 remains an external installation and is valid only when both `acestep/acestep_v15_pipeline.py` and the platform-specific `.venv` Python exist. Windows targets an RTX 4060 8 GB with batch size 1 and CPU offload. Keep the low-memory restart mode as the default.

SoundCloud automation uses bundled `playwright-core` with the installed Google Chrome. Each account has a separate persistent profile under the Music Factory data directory. The legacy Chrome Bridge is not part of the active queue. Do not copy cookies, passwords, Playwright profiles, or rights confirmation between computers. Backup import may transfer descriptive metadata and audio, but machine-specific paths, browser authentication, and legal confirmation stay local.

Build with `npm run build:mac` or `npm run build:windows`. A build made on macOS is not proof that the Windows executable, NVIDIA driver, CUDA/PyTorch environment, or Chrome integration works; perform a Windows smoke test and one non-publishing generation test on the target machine.
