"use strict";
var os = require("os");
var fs = require("fs");
var path = require("path");
var exec = require("child_process").exec;

var soajs = require("soajs");
var whereis = require('whereis');

//external libs
var ncp = require("ncp");
var rimraf = require("rimraf");

var dataDir = __dirname + "/../data/";

module.exports = {
	"updateCustomData": function (req, res, body, section, cb) {
		fs.exists(dataDir + "custom.js", function (exists) {
			if (exists) {
				delete require.cache[require.resolve(dataDir + "custom.js")];
				var custom = require(dataDir + "custom.js");
				custom[section] = {};
				for (var i in body) {
					if (body[i] && body[i] !== "") {
						custom[section][i] = body[i];
					}
				}
				writeFileAndExit(custom);
			}
			else {
				var custom = {};
				custom[section] = JSON.parse(JSON.stringify(body));
				writeFileAndExit(custom);
			}
		});

		function writeFileAndExit(custom) {
			custom = "\"use strict\";" + os.EOL + "module.exports = " + JSON.stringify(custom, null, 2) + ";";
			fs.writeFile(dataDir + "custom.js", custom, "utf8", function (error) {
				if (error) {
					return res.json(req.soajs.buildResponse(res, {code: 174, msg: error.message}));
				}
				if (cb && typeof(cb) === 'function') {
					return cb();
				}
				return res.json(req.soajs.buildResponse(null, true));
			});
		}
	},

	"loadCustomData": function (section, cb) {
		fs.exists(dataDir + "custom.js", function (exists) {
			if (!exists) {
				return cb(null);
			}
			else {
				delete require.cache[require.resolve(dataDir + "custom.js")];
				var customData = require(dataDir + "custom.js");
				if (section) {
					return cb(customData[section]);
				}
				else {
					return cb(customData);
				}
			}
		});
	},

	"generateExtKeys": function (opts, cb) {
		//soajs encryption engine
		var module = require("soajs/modules/soajs.core").key;
		var key = opts.key;

		var tenant = {
			id: opts.tenantId
		};
		var application = {
			"package": opts.package
		};
		var config = {
			algorithm: "aes256",
			password: opts.secret
		};

		module.generateExternalKey(key, tenant, application, config, function (error, extKey) {
			if (error) {
				return cb(error);
			}

			module.getInfo(extKey, config, function (error, response) {
				if (error) {
					return cb(error);
				}
				if (response.key === key) {
					opts.extKey = extKey;
					return cb(null, true);
				}
				else {
					return cb(new Error("Generated Key is invalid."))
				}
			});
		});
	},

	"reCreateFolder": function (cb) {
		var source = dataDir + "provision/";
		var destination = dataDir + "startup/";

		fs.exists(destination, function (exists) {
			if (exists) {
				rimraf(destination, function (error) {
					if (error) {
						return cb(error);
					}
					ncp(source, destination, cb);
				});
			}
			else {
				ncp(source, destination, cb);
			}
		});
	},

	"fillFiles": function (folder, body) {
		var clusters = JSON.parse(JSON.stringify(body.clusters));
		delete clusters.prefix;

		//fix clusters credentials
		if (clusters.credentials.username === "") {
			clusters.credentials = {};
			delete clusters.URLParam.authSource;
		}

		if (clusters.servers[0].host.indexOf("https") !== -1) {
			clusters.URLParam.ssl = true;
			body.clusters.URLParam.ssl = true;
		}

		if(clusters.replicaSet){
			clusters.URLParam.replicaSet = clusters.replicaSet;
			clusters.URLParam.readPreference = "secondaryPreferred";
			clusters.URLParam.w = "majority";
			clusters.URLParam.ha = true;

			if(!clusters.extraParam.replSet){
				clusters.extraParam.replSet = {};
			}
			clusters.extraParam.replSet.ha = true;
		}

		//generate profile
		var profileData = '"use strict;"' + os.EOL;
		clusters.name = "core_provision";
		clusters.prefix = body.clusters.prefix || "";
		var mongoExt = clusters.mongoExt;
		if(!mongoExt){
			if(body.deployment.deployDriver.indexOf("container.docker") !== -1){
				clusters.servers = [
					{
						host: "dashboard-soajsdata",
						port: 27017
					}
				];
			}
			if(body.deployment.deployDriver.indexOf("container.kubernetes") !== -1){
				clusters.servers = [
					{
						host: "dashboard-soajsdata",
						port: 5000 + 27017
					}
				];
			}
		}
		
		delete clusters.replicaSet;
		delete clusters.mongoExt;
		
		profileData += 'module.exports = ' + JSON.stringify(clusters, null, 2) + ';';
		fs.writeFileSync(folder + "profile.js", profileData, "utf8");

		if(body.deployment.deployDriver.indexOf("kubernetes") !== -1 && !mongoExt){
			clusters.servers[0].port = 27017;
		}
		
		delete clusters.name;
		delete clusters.prefix;

		//modify users file
		var userData = fs.readFileSync(folder + "urac/users/owner.js", "utf8");
		userData = userData.replace(/%username%/g, body.gi.username);
		userData = userData.replace(/%email%/g, body.gi.email);

		var Hasher = soajs.hasher;
		Hasher.init({
			"hashIterations": 1024,
			"seedLength": 32
		});
		var hashedPwd = Hasher.hash(body.gi.password);
		userData = userData.replace(/%password%/g, hashedPwd);
		fs.writeFile(folder + "urac/users/owner.js", userData, "utf8");

		if (body.deployment.deployType === 'manual' || body.deployment.deployDriver.indexOf("local") !== -1) {
			body.deployment.deployDockerNodes = [];
		}

		//modify environments file
		var envData = fs.readFileSync(folder + "environments/dashboard.js", "utf8");
		envData = envData.replace(/%domain%/g, body.gi.domain);
		envData = envData.replace(/%site%/g, body.gi.site);
		envData = envData.replace(/%api%/g, body.gi.api);
		envData = envData.replace(/%wrkDir%/g, body.gi.wrkDir);
		envData = envData.replace(/%deployType%/g, body.deployment.deployType);
		envData = envData.replace(/%deployDriver%/g, body.deployment.deployDriver);
		envData = envData.replace(/%deployDockerNodes%/g, body.deployment.deployDockerNodes);
		envData = envData.replace(/%clusterPrefix%/g, body.clusters.prefix);
		envData = envData.replace(/"%clusters%"/g, JSON.stringify(clusters, null, 2));
		envData = envData.replace(/%keySecret%/g, body.security.key);
		envData = envData.replace(/%sessionSecret%/g, body.security.session);
		envData = envData.replace(/%cookieSecret%/g, body.security.cookie);
		fs.writeFile(folder + "environments/dashboard.js", envData, "utf8");

		//modify tenants file
		var tntData = fs.readFileSync(folder + "tenants/owner.js", "utf8");
		tntData = tntData.replace(/%email%/g, body.gi.email);
		tntData = tntData.replace(/%site%/g, body.gi.site);
		tntData = tntData.replace(/%domain%/g, body.gi.domain);
		tntData = tntData.replace(/%wrkDir%/g, body.gi.wrkDir);
		tntData = tntData.replace(/%extKey1%/g, body.security.extKey1);
		tntData = tntData.replace(/%extKey2%/g, body.security.extKey2);
		fs.writeFile(folder + "tenants/owner.js", tntData, "utf8");

		//modify dashboard extKey file
		var tntData = fs.readFileSync(folder + "extKeys/keys.js", "utf8");
		tntData = tntData.replace(/%extKey2%/g, body.security.extKey2);
		fs.writeFile(folder + "extKeys/keys.js", tntData, "utf8");

		//remove unneeded file
		fs.unlinkSync(folder + "tenants/info.js");
	},

	"importMongo": function (folder, body, cb) {
		//copy data.js to startup
		//add prefix while copying
		fs.readFile(dataDir + "data.js", "utf8", function (error, readData) {
			if (error) {
				return res.json(req.soajs.buildResponse({"code": 400, "msg": error.message}));
			}

			var writeStream = fs.createWriteStream(folder + "data.js");
			writeStream.write("var dbPrefix = '" + body.clusters.prefix + "';" + os.EOL);
			writeStream.write(readData);
			writeStream.end();

			//wait 500ms for the write to ensure it finished then return the cb
			setTimeout(function () {
				return cb(null, true);
			}, 500);
		});
	},

	"unifyData": function (def, over) {
		if(over.gi){
			for (var i in def.gi) {
				if (over.gi[i] && over.gi[i] !== "") {
					def.gi[i] = over.gi[i];
				}
			}
		}

		if(over.security){
			for (var i in def.security) {
				if (over.security[i] && over.security[i] !== "") {
					def.security[i] = over.security[i];
				}
			}
		}

		if(over.deployment){
			for (var i in def.deployment) {
				if (over.deployment[i]) {
					def.deployment[i] = over.deployment[i];
				}
			}

			for (var j in over.deployment) {
				def.deployment[j] = over.deployment[j];
			}
		}

		if(over.clusters){
			for (var j in over.clusters) {
				def.clusters[j] = over.clusters[j];
			}
		}

		return def;
	},

	"deployManual": function (body, cb) {
		body.gi.wrkDir = path.normalize(body.gi.wrkDir);
		//launch deployer
		whereis('node', function (err, nodePath) {
			if (err) {
				return cb(err);
			}
			whereis("npm", function (err, npmPath) {
				if (err) {
					return cb(err);
				}

				var runner = fs.createWriteStream(path.normalize(__dirname + "/../scripts/manual-deploy.sh"));
				runner.write("#!/bin/bash" + os.EOL + os.EOL);
				var envs = {
					"NODE_PATH": nodePath,
					"NPM_PATH": npmPath,
					"DEPLOY_FROM": process.env.DEPLOY_FROM || "NPM",
					"SOAJS_GIT_DASHBOARD_BRANCH": process.env.SOAJS_GIT_DASHBOARD_BRANCH || "master",
					"SOAJS_GIT_BRANCH": process.env.SOAJS_GIT_BRANCH || "master",
					"SOAJS_DATA_FOLDER": path.normalize(dataDir + "startup/"),
					"SOAJS_PROFILE": path.normalize(dataDir + "startup/profile.js"),
					"INSTALLER_DIR": path.normalize(__dirname + "/../scripts/"),
					"SOAJS_DEPLOY_DIR": body.gi.wrkDir,
					"API_PREFIX": body.gi.api,
					"SITE_PREFIX": body.gi.site,
					"MASTER_DOMAIN": body.gi.domain
				};
				if(body.clusters.replicaSet){
					envs['SOAJS_MONGO_RSNAME'] = body.clusters.replicaSet;
				}

				for (var e in envs) {
					runner.write("export " + e + "=" + envs[e] + os.EOL);
				}

				runner.write(os.EOL + "#Run Deployment Script ..." + os.EOL);
				runner.write(nodePath + " " + path.normalize(__dirname + "/../scripts/manual.js") + os.EOL);
				runner.write(os.EOL + "#Start Nginx ..." + os.EOL);

				if(process.platform === 'darwin'){
					runner.write("brew services start nginx" + os.EOL);
				}
				else {
					runner.write("sudo service nginx start" + os.EOL);
				}

				runner.write(os.EOL + "ps aux | grep node" + os.EOL);
				runner.end();

				fs.chmodSync(path.normalize(__dirname + "/../scripts/manual-deploy.sh"), "0755");

				return cb(null, {
					"hosts": {
						"api": "127.0.0.1 " + body.gi.api + "." + body.gi.domain,
						"site": "127.0.0.1 " + body.gi.site + "." + body.gi.domain
					},
					"ui": "http://" + body.gi.site + "." + body.gi.domain,
					"cmd": "sudo " + path.normalize(__dirname + "/../scripts/manual-deploy.sh")
				});
			});
		});
	},

	"deployContainer": function (body, driver, loc, cb) {
		whereis('node', function (err, nodePath) {
			if (err) {
				return cb(err);
			}

			if (driver === 'docker') {
				var runner = fs.createWriteStream(path.normalize(__dirname + "/../scripts/swarm-deploy.sh"));
				runner.write("#!/bin/bash" + os.EOL + os.EOL);

				var envs = {
					"SOAJS_GIT_DASHBOARD_BRANCH": process.env.SOAJS_GIT_DASHBOARD_BRANCH || "develop",
					"SOAJS_GIT_BRANCH": process.env.SOAJS_GIT_BRANCH || "develop",
					"SOAJS_PROFILE": path.normalize(dataDir + "startup/profile.js"),

					"API_PREFIX": body.gi.api,
					"SITE_PREFIX": body.gi.site,
					"MASTER_DOMAIN": body.gi.domain,

					"MONGO_EXT": body.clusters.mongoExt,

					"SOAJS_GIT_OWNER": body.deployment.gitOwner,
					"SOAJS_GIT_REPO": body.deployment.gitRepo,
					"SOAJS_GIT_TOKEN": body.deployment.gitToken,

					"SOAJS_DATA_FOLDER": path.normalize(dataDir + "startup/"),
					"SOAJS_IMAGE_PREFIX": body.deployment.imagePrefix,

					"NGINX_HTTP_PORT": body.deployment.nginxPort,
					"NGINX_HTTPS_PORT": body.deployment.nginxSecurePort,
					"SOAJS_NX_SSL": body.deployment.nginxSsl,


					"SWARM_INTERNAL_PORT": body.deployment.docker.dockerInternalPort,
					"SOAJS_DOCKER_SOCKET": body.deployment.docker.dockerSocket,
					"DOCKER_NETWORK": body.deployment.docker.networkName,
					"CONTAINER_HOST": body.deployment.containerHost,
					"CONTAINER_PORT": body.deployment.docker.containerPort,
					"SOAJS_DOCKER_REPLICA": body.deployment.dockerReplica
				};

				if(body.clusters.replicaSet){
					envs['SOAJS_MONGO_RSNAME'] = body.clusters.replicaSet;
				}

				if(body.deployment.docker.containerDir || body.deployment.docker.certificatesFolder) {
					envs["SOAJS_DOCKER_CERTS_PATH"] = body.deployment.docker.containerDir || body.deployment.docker.certificatesFolder;
				}

				for (var e in envs) {
					if(envs[e] !== null){
						runner.write("export " + e + "=" + envs[e] + os.EOL);
					}
				}

				if(!body.clusters.mongoExt){
					runner.write("sudo " + "killall mongo" + os.EOL);
				}

				runner.write(os.EOL + nodePath + " " + path.normalize(__dirname + "/../scripts/docker.js") + os.EOL);
				runner.end();

				generateResponse("swarm");
			}
			else if (driver === 'kubernetes') {

				var runner = fs.createWriteStream(path.normalize(__dirname + "/../scripts/kubernetes-deploy.sh"));
				runner.write("#!/bin/bash" + os.EOL + os.EOL);

				var envs = {
					"SOAJS_GIT_DASHBOARD_BRANCH": process.env.SOAJS_GIT_DASHBOARD_BRANCH || "develop",
					"SOAJS_GIT_BRANCH": process.env.SOAJS_GIT_BRANCH || "develop",
					"SOAJS_PROFILE": path.normalize(dataDir + "startup/profile.js"),

					"API_PREFIX": body.gi.api,
					"SITE_PREFIX": body.gi.site,
					"MASTER_DOMAIN": body.gi.domain,

					"MONGO_EXT": body.clusters.mongoExt,

					"SOAJS_GIT_OWNER": body.deployment.gitOwner,
					"SOAJS_GIT_REPO": body.deployment.gitRepo,
					"SOAJS_GIT_TOKEN": body.deployment.gitToken,

					"SOAJS_DATA_FOLDER": path.normalize(dataDir + "startup/"),
					"SOAJS_IMAGE_PREFIX": body.deployment.imagePrefix,

					"NGINX_HTTP_PORT": body.deployment.nginxPort,
					"NGINX_HTTPS_PORT": body.deployment.nginxSecurePort,
					"SOAJS_NX_SSL": body.deployment.nginxSsl,

					"CONTAINER_HOST": body.deployment.containerHost,
					"CONTAINER_PORT": body.deployment.kubernetes.containerPort,
					"SOAJS_DOCKER_REPLICA": body.deployment.dockerReplica
				};

				if(body.deployment.kubernetes.containerDir || body.deployment.kubernetes.certificatesFolder) {
					envs["SOAJS_DOCKER_CERTS_PATH"] = body.deployment.kubernetes.containerDir || body.deployment.kubernetes.certificatesFolder;
				}

				for (var e in envs) {
					if(envs[e] !== null){
						runner.write("export " + e + "=" + envs[e] + os.EOL);
					}
				}

				if(!body.clusters.mongoExt){
					runner.write("sudo " + "killall mongo" + os.EOL);
				}

				runner.write(os.EOL + nodePath + " " + path.normalize(__dirname + "/../scripts/kubernetes.js") + os.EOL);
				runner.end();

				generateResponse("kubernetes");
			}
			else{
				return cb(new Error("Invalid Deployment Strategy Requested: " + driver));
			}
		});

		function generateResponse(type){
			fs.chmodSync(path.normalize(__dirname + "/../scripts/" + type + "-deploy.sh"), "0755");

			var obj = {
				"hosts": {
					"api": body.deployment.containerHost + " " + body.gi.api + "." + body.gi.domain,
					"site": body.deployment.containerHost + " " + body.gi.site + "." + body.gi.domain
				},
				"ui": "http://" + body.gi.site + "." + body.gi.domain,
				"cmd": "sudo " + path.normalize(__dirname + "/../scripts/" + type + "-deploy.sh")
			};

			if(!body.clusters.mongoExt){
				obj['hosts'].mongo = body.deployment.containerHost + " dashboard-soajsdata";
			}
			else{
				obj['hosts'].mongo = body.clusters.servers[0].host + " dashboard-soajsdata";
			}

			return cb(null, obj);
		}
	}
};
