const path = require('path');
const shortid = require('shortid');
const { fs, log, selectors, util } = require('vortex-api');

const GAME_ID = 'dyinglight2';
const STEAMAPP_ID = '534380';
const STEAM_DLL = path.join('engine', 'source', 'bin', 'x64', 'steam_api64.dll');

const PAK_EXT = '.pak';
let STORE_ID;
function findGame() {
    return util.GameStoreHelper.findByAppId([STEAMAPP_ID])
      .then(game => {
        STORE_ID = game.gameStoreId;
        return Promise.resolve(game.gamePath);
      });
}

function modsPath(discoveryPath) {
  return discoveryPath !== undefined
    ? path.join(discoveryPath, 'ph', 'source')
    : path.join('ph', 'source');
}

function prepareForModding(context, discovery) {
  const findStoreId = () => findGame().catch(err => Promise.resolve());
  const startSteam = () => findStoreId()
    .then(() => (STORE_ID === 'steam')
      ? util.GameStoreHelper.launchGameStore(context.api, STORE_ID, undefined, true)
      : Promise.resolve());
  return fs.ensureDirWritableAsync(modsPath(discovery.path))
    .then(() => startSteam());
}


function installContent(api, files) {
  const rootCandidate = files.find(file => file.toLowerCase().split(path.sep).includes('ph'));
  const idx = rootCandidate !== undefined
    ? rootCandidate.toLowerCase().split(path.sep).findIndex(seg => seg === 'ph')
    : 0;

  let hasVariants = false;
  const pakFiles = files.reduce((accum, iter) => {
    if (path.extname(iter) === '.pak') {
      const exists = accum[path.basename(iter)] !== undefined;
      if (exists) {
        hasVariants = true;
      }
      accum[path.basename(iter)] = exists
        ? accum[path.basename(iter)].concat(iter)
        : [iter];
    }
    return accum;
  }, {});

  let filtered = files;
  const queryVariant = () => {
    const paks = Object.keys(pakFiles).filter(key => pakFiles[key].length > 1);
    return Promise.map(paks, pakFile => {
        return api.showDialog('question', 'Choose Variant', {
          text: 'This mod has several variants for "{{pak}}" - please '
              + 'choose the variant you wish to install. (You can choose a '
              + 'different variant by re-installing the mod)',
          choices: pakFiles[pakFile].map((iter, idx) => ({ 
            id: iter,
            text: iter,
            value: idx === 0,
          })),
          parameters: {
            pak: pakFile,
          },
        }, [
          { label: 'Cancel' },
          { label: 'Confirm' },
        ]).then(res => {
          if (res.action === 'Confirm') {
            const choice = Object.keys(res.input).find(choice => res.input[choice]);
            filtered = filtered.filter(file => (path.extname(file) !== PAK_EXT)
              || ((path.basename(file) === pakFile) && file.includes(choice))
              || (path.basename(file) !== pakFile));
            return Promise.resolve();
          } else {
            return new util.UserCanceled();
          }
        });
      })
    };
  const generateInstructions = () => {
    const fileInstructions = filtered.reduce((accum, iter) => {
      if (!iter.endsWith(path.sep)) {
        iter = iter.match(/data[0-9]*.pak/) !== null
          ? iter : 'data2.pak';
        const destination = isPak(iter)
          ? shortid() + PAK_EXT
          : iter.split(path.sep).slice(idx).join(path.sep);
        if (isPak(iter)) {
          const pakDictIdx = accum.findIndex(attrib =>
            (attrib.type === 'attribute') && (attrib.key === 'pakDictionary'));
          if (pakDictIdx !== -1) {
            accum[pakDictIdx] = {
              ...accum[pakDictIdx],
              [destination]: path.basename(iter),
            }
          } else {
            accum.push({
              type: 'attribute',
              key: 'pakDictionary',
              value: { [destination]: path.basename(iter) },
            });
          }
        }
        accum.push({
          type: 'copy',
          source: iter,
          destination, 
        });
      }
      return accum;
    }, []);
    const instructions = [{ 
      type: 'setmodtype',
      value: 'dying-light-2-pak-merger',
    }].concat(fileInstructions);
    return instructions;
  }

  const prom = hasVariants ? queryVariant : Promise.resolve;
  return prom()
    .then(() => Promise.resolve({ instructions: generateInstructions() }));
}


function testSupportedContent(files, gameId) {
  // Make sure we're able to support this mod.
  let supported = (gameId === GAME_ID) &&
    (files.find(file => path.extname(file).toLowerCase() === PAK_EXT) !== undefined);

  return Promise.resolve({
    supported,
    requiredFiles: [],
  });
}

// filePath points to the mod file
// mergeDir points to the __merged directory
function merge(api, filePath, mergeDir) {
  const state = api.getState();
  const modId = Object.keys(state.persistent.mods[GAME_ID]).find(id => filePath.includes(id));
  let pakDict;
  if (modId !== undefined) {
    const mod = state.persistent.mods[GAME_ID][modId];
    pakDict = mod.attributes.pakDictionary;
  }

  if (pakDict[path.basename(filePath)] === undefined) {
    log('error', 'file is not present in pak dictionary', { filePath, pakDict: JSON.stringify(pakDict, undefined, 2) });
    return Promise.resolve();
  }
  const sevenzip = new util.SevenZip();
  const destDir = path.join(mergeDir, modsPath());
  const mergeFilePath = path.join(destDir, pakDict[path.basename(filePath)]);
  const zipFile = mergeFilePath + '.zip';
  const tempDir = path.join(mergeDir, 'temp');
  return fs.ensureDirWritableAsync(destDir)
    .then(() => fs.ensureDirWritableAsync(tempDir))
    .then(() => fs.statAsync(mergeFilePath)
      .then(() => sevenzip.extractFull(mergeFilePath, tempDir))
      .catch(err => err.code === 'ENOENT')
        ? Promise.resolve()
        : Promise.reject(err))
    .then(() => sevenzip.extractFull(filePath, tempDir))
    .then(() => new Promise((resolve, reject) => setTimeout(() => resolve(), 500)))
    .then(() => fs.readdirAsync(tempDir))
    .then(entries => sevenzip.add(zipFile, entries.map(entry => path.join(tempDir, entry)),
      { raw: ['-r'] }))
    .then(() => fs.removeAsync(tempDir))
    .then(() => fs.removeAsync(mergeFilePath)
      .catch(err => err.code === 'ENOENT')
        ? Promise.resolve()
        : Promise.reject(err))
    .then(() => fs.moveAsync(zipFile, mergeFilePath, { overwrite: true }));
}

function isPak(filePath) {
  return path.extname(filePath.toLowerCase()) === PAK_EXT;
}

function testMerge(api, game, discovery) {
  if (game.id !== GAME_ID && discovery?.path !== undefined) {
    return undefined;
  }

  const installPath = selectors.installPathForGame(api.store.getState(), game.id);
  return {
    baseFiles: (deployedFiles) => deployedFiles
      .filter(file => isPak(file.relPath))
      .map(file => ({
        in: path.join(installPath, file.source, file.relPath),
        out: file.relPath,
      })),
    filter: filePath => isPak(filePath),
  };
}

function requiresLauncher(gamePath) {
  return fs.readdirAsync(gamePath)
    .then(files => (files.find(file => file.endsWith(STEAM_DLL)) !== undefined)
      ? Promise.resolve({ launcher: 'steam' })
      : Promise.resolve(undefined))
    .catch(err => Promise.reject(err));
}

function main(context) {
  const exe = path.join('ph', 'work', 'bin', 'x64', 'DyingLightGame_x64_rwdi.exe');
	context.registerGame({
    id: GAME_ID,
    name: 'Dying Light 2',
    mergeMods: true,
    queryPath: findGame,
    supportedTools: [],
    requiresLauncher,
    queryModPath: () => modsPath(),
    logo: 'gameart.jpg',
    executable: () => exe,
    requiredFiles: [exe],
    setup: (discovery) => prepareForModding(context, discovery),
    environment: {
      SteamAPPId: STEAMAPP_ID,
    },
    details: {
      steamAppId: STEAMAPP_ID,
      ignoreConflicts: '**/*.pak',
    },
  });

  context.registerInstaller('dyinglight2-mod', 25, testSupportedContent, (files) => installContent(context.api, files));
  context.registerModType('dying-light-2-pak-merger', 25,
    (gameId) => gameId === GAME_ID, () => {
      const state = context.api.getState();
      const gamePath = state.settings.gameMode.discovered?.[GAME_ID]?.path;
      return gamePath;
    }, () => Promise.resolve(false), {
    mergeMods: true,
    name: 'Pak Mod',
  });
  context.registerMerge(
    (game, discovery) => testMerge(context.api, game, discovery),
    (filePath, mergeDir) => merge(context.api, filePath, mergeDir),
    'dying-light-2-pak-merger');
	return true
}

module.exports = {
    default: main,
  };