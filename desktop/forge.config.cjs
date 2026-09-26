const path = require('node:path');
const packageJson = require('./package.json');

const iconPath = process.env.H5_SCORM_ICON_PATH || path.join(__dirname, 'assets', 'icon.ico');

module.exports = {
  packagerConfig: {
    ...(process.env.H5_SCORM_ELECTRON_ZIP_DIR ? { electronZipDir: process.env.H5_SCORM_ELECTRON_ZIP_DIR } : {}),
    asar: true,
    executableName: 'H5SCORMEditor',
    icon: iconPath,
    ignore: [
      /^\/src(?:\/|$)/,
      /^\/scripts(?:\/|$)/,
      /^\/node_modules(?:\/|$)/,
      /^\/releases(?:\/|$)/,
      /^\/tsconfig\.json$/,
      /^\/out(?:\/|$)/,
    ],
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'H5SCORMEditor',
        authors: 'H5 SCORM Editor contributors',
        description: 'H5 SCORM 课程轻量编辑器',
        setupIcon: iconPath,
        setupExe: `H5-SCORM-Editor-${packageJson.version}-Setup.exe`,
      },
    },
  ],
};
