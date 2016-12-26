const fs = require('fs');
const prompt = require('prompt');
const child_process = require('child_process');

const baseDir = __dirname + '/../..';

function getPackages() {
    return fs.readdirSync(baseDir)
        .map(dir => {
            const path = baseDir + '/' + dir + '/package.json';
            if (fs.existsSync(path)) {
                const json = require(path);
                if (!json.private && json.version) {
                    return json;
                }
            }
        })
        .filter(v => v);
}

function getCurrentVersion() {
    return getPackages().map(json => json.version)[0];
}

function getNextVersion() {
    return getCurrentVersion().replace(/[0-9]+$/, v => ++v);
}

prompt.start();
prompt.get({
    properties: {
        version: {
            description: 'Enter new version',
            pattern: /^[0-9]+\.[0-9]+\.[0-9]+$/,
            message: 'Wrong version format. Example: 0.10.1',
            default: getNextVersion()
        }
    }
}, function (err, result) {
    if (err) {
        console.error(String(err));
        return;
    }

    // Update version
    getPackages().forEach(json => {
        console.log(`Update ${json.name} to ${result.version}...`);

        let path = `${baseDir}/${json.name}/package.json`;
        let data = fs.readFileSync(path);
        data = data.toString().replace('"version": "' + json.version + '"', '"version": "' + result.version + '"');
        fs.writeFileSync(path, data);
    });

    prompt.get({
        properties: {
            yn: {
                description: 'Publish all packages to npm?',
                pattern: /^(y|n)$/i,
                message: 'Wrong format. Need: y or n',
                default: 'y'
            }
        }
    }, function (err, result) {
        if (err) {
            console.error(String(err));
            return;
        }

        // Publish all
        if (result.yn === 'y') {
            getPackages().forEach(json => {
                child_process.exec(`git commit -m 'v${result.version}' package.json && git push`, {
                    cwd: `${baseDir}/${json.name}`
                }, (error, stdout, stderr) => {
                    if (error) {
                        console.error(error);
                    } else {
                        console.log(stdout);
                    }
                });

                child_process.exec('npm publish', {
                    cwd: `${baseDir}/${json.name}`
                }, (error, stdout, stderr) => {
                    if (error) {
                        console.error(error);
                    } else {
                        console.log(stdout);
                    }
                });
            });
        }
    });

});