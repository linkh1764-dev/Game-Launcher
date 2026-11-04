# Game Launcher

## Run it
1. Install Node.js (https://nodejs.org)
2. In this folder: `npm install`
3. `npm start`

## Build installers
- Windows: `npm run build:win` (installer + portable .exe)
- Linux:   `npm run build:linux` (AppImage + .deb)

Build each OS's installer on that OS (Windows builds on Windows, Linux builds on Linux).
Your library is saved to `library.json` in Electron's userData folder
(Windows: %APPDATA%/game-launcher, Linux: ~/.config/game-launcher).