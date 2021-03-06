'use strict';
var Docker = require('dockerode');
var async = require('async');

var path = require('path');
var fs = require('fs');
var Grid = require('gridfs-stream');
var spawn = require('child_process').spawn;
var soajs = require('soajs');
var request = require('request');

var config = require('./config.js');
var folder = config.folder;
delete require.cache[config.profile];
var profile = soajs.utils.cloneObj(require(config.profile));
var profile2 = JSON.parse(JSON.stringify(profile));
if(!process.env.MONGO_EXT || process.env.MONGO_EXT === 'false'){
	profile2.servers[0].port = parseInt(process.env.MONGO_PORT) || 27017;
}

var mongo = new soajs.mongo(profile2);
var analyticsCollection = 'analytics';
var utilLog = require('util');
var dbConfiguration = require('../../../data/startup/environments/dashboard');
var esClient;

var lib = {

    "loadCustomData": function (cb) {
        var dataDir = process.env.SOAJS_DATA_FOLDER;

        fs.exists(path.normalize(dataDir + "/../custom.js"), function (exists) {
            if (!exists) {
                return cb(null);
            }
            else {
                delete require.cache[require.resolve(path.normalize(dataDir + "/../custom.js"))];
                var customData = require(path.normalize(dataDir + "/../custom.js"));
                return cb(customData);
            }
        });
    },

    ifSwarmExists: function (deployer, cb) {
        deployer.info(function (error, info) {
            if (error) return cb(error);

            var swarmExists = false;
            if (info.Swarm) {
                swarmExists = (info.Swarm.LocalNodeState === 'active' && info.Swarm.Nodes > 0);
            }

            return cb(null, swarmExists);
        });
    },

    printProgress: function (message, counter) {
        process.stdout.clearLine();
        process.stdout.write(showTimestamp() + ' - ' + message + ' ' + showDots() + '\r');

        function showDots() {
            var output = '';
            var numOfDots = counter % 5;
            for (var i = 0; i < numOfDots; i++) {
                output += '.';
            }
            return output;
        }

        function showTimestamp() {
            var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
            var now = new Date();
            return '' + now.getDate() + ' ' + months[now.getMonth()] + ' ' + now.getHours() + ':' +
                ((now.getMinutes().toString().length === 2) ? now.getMinutes() : '0' + now.getMinutes()) + ':' +
                ((now.getSeconds().toString().length === 2) ? now.getSeconds() : '0' + now.getSeconds());
        }
    },

    getDeployer: function (dockerObj, cb) {
        var deployerConfig = {
            "host": dockerObj.machineIP,
            "port": dockerObj.machinePort
        };
        if (typeof (deployerConfig.host) === 'string' && deployerConfig.host === '127.0.0.1') {
            return cb(null, new Docker({socketPath: config.docker.socketPath}));
        }
        else {
        	if(!config.docker.certsPath){
        		return cb(new Error('No certificates found for remote machine.'));
	        }
            deployerConfig.ca = fs.readFileSync(config.docker.certsPath + '/ca.pem');
            deployerConfig.cert = fs.readFileSync(config.docker.certsPath + '/cert.pem');
            deployerConfig.key = fs.readFileSync(config.docker.certsPath + '/key.pem');

            return cb(null, new Docker(deployerConfig));
        }
    },

    getContent: function (type, group, cb) {
        var path = config.services.path.dir + group + '/';
        fs.exists(path, function (exists) {
            if (!exists) {
                utilLog.log('Folder [' + path + '] does not exist, skipping ...');
                return cb(null, true);
            }

            fs.readdir(path, function (error, content) {
                if (error) return cb(error);

                var regex = new RegExp('[a-zA-Z0-9]*\.' + config.services.path.fileType, 'g');
                var loadContent, allContent = [];
                content.forEach(function (oneContent) {
                    if (oneContent.match(regex)) {
                        try {
                            loadContent = require(path + oneContent);
                        }
                        catch (e) {
                            return cb(e);
                        }
                        allContent.push(loadContent);
                    }
                });
                return cb(null, allContent);
            });
        });
    },

    deployGroup: function (type, services, deployer, cb) {
        if (services.length === 0) {
            utilLog.log('No services of type [' + type + '] found, skipping ...');
            return cb(null, true);
        }

        if (type === 'db' && config.mongo.external) {
            utilLog.log('External Mongo deployment detected, data containers will not be deployed ...');
            return cb(null, true);
        }
	    if (type === 'elk' && (!config.analytics || config.analytics === "false")) {
		    return cb(null, true);
	    }
        async.eachSeries(services, function (oneService, callback) {
            if(type === "core"){
                oneService.Labels["soajs.catalog.id"] = process.env.DASH_SRV_ID;
                oneService.Labels["soajs.catalog.v"] = "1";
	            oneService.Labels["service.image.ts"] = new Date().getTime().toString();
            }
            else if (type === "nginx"){
                oneService.Labels["soajs.catalog.id"] = process.env.DASH_NGINX_ID;
	            oneService.Labels["soajs.catalog.v"] = "1";
	            oneService.Labels["service.image.ts"] = new Date().getTime().toString();
            }

            lib.deployService(deployer, oneService, callback);
        }, cb);
    },


    /**
     * Customizes a new nginx recipe used to deploy the NGINX of the dashboard environment
     * @param nginxRecipe
     * @param cb
     * @returns {*}
     */
    updateNginxRecipe (nginxRecipe) {
    	delete nginxRecipe.locked;
        nginxRecipe.name = "Dashboard Nginx Recipe";
        nginxRecipe.description = "This is the nginx catalog recipe used to deploy the nginx in the dashboard environment."
	    nginxRecipe.recipe.deployOptions.image.prefix = config.imagePrefix;
     
	    nginxRecipe.recipe.deployOptions.ports[0].published = config.nginx.port.http;
	    nginxRecipe.recipe.deployOptions.ports[1].published = config.nginx.port.https;
        
        if(process.env.SOAJS_NX_SSL === 'true'){
            process.env['SOAJS_NX_API_HTTPS']=1;
            process.env['SOAJS_NX_API_HTTP_REDIRECT']=1;
            process.env['SOAJS_NX_SITE_HTTPS']=1;
            process.env['SOAJS_NX_SITE_HTTP_REDIRECT']=1;
        }
	
	    nginxRecipe.recipe.buildOptions.env["SOAJS_GIT_DASHBOARD_BRANCH"] = {
		    "type": "static",
		    "value": config.dashUISrc.branch
	    };
     
	    if (config.customUISrc.repo && config.customUISrc.owner) {
		    nginxRecipe.recipe.buildOptions.env["SOAJS_GIT_REPO"] = {
			    "type": "userInput",
			    "default": config.customUISrc.repo,
                "label": "Git Repo"
		    };
		
		    nginxRecipe.recipe.buildOptions.env["SOAJS_GIT_OWNER"] = {
			    "type": "userInput",
			    "default": config.customUISrc.owner,
                "label": "Git Repo"
		    };
		
		    if (config.customUISrc.branch) {
			    nginxRecipe.recipe.buildOptions.env["SOAJS_GIT_BRANCH"] = {
				    "type": "userInput",
				    "default": config.customUISrc.branch,
                    "label": "Git Branch"
			    };
		    }
		
		    if (config.customUISrc.provider) {
			    nginxRecipe.recipe.buildOptions.env["SOAJS_GIT_PROVIDER"] = {
				    "type": "userInput",
				    "default": config.customUISrc.provider,
                    "label": "Git Provider"
			    };
		    }
		
		    if (config.customUISrc.domain) {
			    nginxRecipe.recipe.buildOptions.env["SOAJS_GIT_DOMAIN"] = {
				    "type": "userInput",
				    "default": config.customUISrc.domain,
                    "label": "Git Provider"
			    };
		    }
		
		    if (config.customUISrc.token) {
			    nginxRecipe.recipe.buildOptions.env["SOAJS_GIT_TOKEN"] = {
				    "type": "userInput",
				    "default": config.customUISrc.token,
                    "label": "Git Token"
			    };
		    }
		    if (config.customUISrc.path) {
			    nginxRecipe.recipe.buildOptions.env["SOAJS_GIT_PATH"] = {
				    "type": "userInput",
				    "default": config.customUISrc.path,
				    "label": "Git Path"
			    };
		    }
	    }
	    
        //Add every environment variable that is added by the installer.
        //Add environment variables related to SSL
        if(process.env.SOAJS_NX_API_HTTPS){
            nginxRecipe.recipe.buildOptions.env["SOAJS_NX_API_HTTPS"] = {
                "type": "userInput",
                "default": process.env.SOAJS_NX_API_HTTPS,
                "label": "API HTTPS"
            };
        }
        if(process.env.SOAJS_NX_API_HTTP_REDIRECT){
            nginxRecipe.recipe.buildOptions.env["SOAJS_NX_API_HTTP_REDIRECT"] = {
                "type": "userInput",
                "default": process.env.SOAJS_NX_API_HTTP_REDIRECT,
                "label": "API HTTP Redirect"
            };
        }
        if(process.env.SOAJS_NX_SITE_HTTPS){
            nginxRecipe.recipe.buildOptions.env["SOAJS_NX_SITE_HTTPS"] = {
                "type": "userInput",
                "default": process.env.SOAJS_NX_SITE_HTTPS,
                "label": "Site HTTPS"
            };
        }
        if(process.env.SOAJS_NX_SITE_HTTP_REDIRECT){
            nginxRecipe.recipe.buildOptions.env["SOAJS_NX_SITE_HTTP_REDIRECT"] = {
                "type": "userInput",
                "default": process.env.SOAJS_NX_SITE_HTTP_REDIRECT,
                "label": "Site HTTP Redirect"
            };
        }

        return nginxRecipe;
    },

    /**
     * Customizes a new service recipe used to deploy the core services of the dashboard environment
     * @param serviceRecipe
     * @param cb
     * @returns {*}
     */
    updateServiceRecipe (serviceRecipe) {
	    delete serviceRecipe.locked;
        serviceRecipe.name = "Dashboard Service Recipe";
	    serviceRecipe.description = "This is the service catalog recipe used to deploy the core services in the dashboard environment."
	    serviceRecipe.recipe.deployOptions.image.prefix = config.imagePrefix;
	    
	    if(config.deploy_acc){
		    serviceRecipe.recipe.buildOptions.env["SOAJS_DEPLOY_ACC"] = {
			    "type": "static",
			    "value": "true"
		    };
	    }
	    
        //Add environment variables containing mongo information
        if(profile.servers && profile.servers.length > 0){
            serviceRecipe.recipe.buildOptions.env["SOAJS_MONGO_NB"] = {
                "type": "computed",
                "value": "$SOAJS_MONGO_NB"
            };
	
	        serviceRecipe.recipe.buildOptions.env["SOAJS_MONGO_IP"] = {
		        "type": "computed",
		        "value": "$SOAJS_MONGO_IP_N"
	        };
	
	        serviceRecipe.recipe.buildOptions.env["SOAJS_MONGO_PORT"] = {
		        "type": "computed",
		        "value": "$SOAJS_MONGO_PORT_N"
	        };
        }
        
        if(profile.prefix && profile.prefix !== ''){
            serviceRecipe.recipe.buildOptions.env["SOAJS_MONGO_PREFIX"] = {
                "type": "computed",
                "value": "$SOAJS_MONGO_PREFIX"
            };
        }
        
        if(profile.URLParam.replicaSet){
            serviceRecipe.recipe.buildOptions.env["SOAJS_MONGO_RSNAME"] = {
                "type": "computed",
                "value": "$SOAJS_MONGO_RSNAME"
            };
        }
        
        if(profile.URLParam.authSource){
            serviceRecipe.recipe.buildOptions.env["SOAJS_MONGO_AUTH_DB"] = {
                "type": "computed",
                "value": "$SOAJS_MONGO_AUTH_DB"
            };
        }
        
        if(profile.URLParam.ssl){
            serviceRecipe.recipe.buildOptions.env["SOAJS_MONGO_SSL"] = {
                "type": "computed",
                "value": "$SOAJS_MONGO_SSL"
            };
        }
	
	    if(profile.credentials.username){
		    serviceRecipe.recipe.buildOptions.env["SOAJS_MONGO_USERNAME"] = {
			    "type": "computed",
			    "value": "$SOAJS_MONGO_USERNAME"
		    };
	    }
	
	    if(profile.credentials.password){
		    serviceRecipe.recipe.buildOptions.env["SOAJS_MONGO_PASSWORD"] = {
			    "type": "computed",
			    "value": "$SOAJS_MONGO_PASSWORD"
		    };
	    }
	    
        return serviceRecipe;
    },

    importData: function (mongoInfo, cb) {
        utilLog.log('Importing provision data to:', profile2.servers[0].host + ":" + profile2.servers[0].port);
        var dataImportFile = __dirname + "/../dataImport/";
        const importFiles = spawn(process.env.NODE_PATH, [ 'index.js' ], { stdio: 'inherit', cwd: dataImportFile });
        importFiles.on('data', (data) => {
            console.log(data.toString());
        });

        importFiles.on('close', (code) => {
            if (code === 0) {
                utilLog.log("Successfully imported the data files.");
                //get the Dashboard Nginx recipe Mongo ID
                setTimeout(function () {
                    const dataFolder = process.env.SOAJS_DATA_FOLDER;
                    //require service and nginx catalog recipes
                    var catalogDefaulEntries = require(dataFolder + "catalogs/index.js");
                    var dashboardCatalogEntries = [catalogDefaulEntries[0], catalogDefaulEntries[3]];
                    //update the catalog recipes to include data used for dashboard environment deployment
                    dashboardCatalogEntries[0] = lib.updateServiceRecipe(dashboardCatalogEntries[0]);
                    dashboardCatalogEntries[1] = lib.updateNginxRecipe(dashboardCatalogEntries[1]);
                    //add catalogs to the database
                    mongo.insert("catalogs", dashboardCatalogEntries, true, (error, catalogEntries) => {
                        if(error){
                           return cb(error);
                        }
	                    utilLog.log("Dashboard Catalog Recipes updated.");
                        process.env.DASH_SRV_ID = catalogEntries[0]._id.toString();
                        process.env.DASH_NGINX_ID = catalogEntries[1]._id.toString();
                        return cb();
                    });
                }, 5000);
            }
            else {
                throw new Error(`Data import failed, exit code: ${code}`);
            }
        });
        importFiles.on("error", (error) => {
            utilLog.log ("Error while importing the data files.");
            return cb(error);
        });
    },

    importCertificates: function (cb) {
        lib.loadCustomData(function(customFile) {
            if(!customFile.deployment.certsRequired)
                return cb(null, true);

            else{
                utilLog.log('Importing certifictes to:', profile2.servers[0].host + ":" + profile2.servers[0].port);
                copyCACertificate(function(caErr){
                    if(caErr){
                        utilLog.log("Error while copying the certificate of type CA");
                        throw new Error(caErr);
                    }
                    copyCertCertificate(function(certErr){
                        if(certErr){
                            utilLog.log("Error while copying the certificate of type Cert");
                            throw new Error(certErr);
                        }
                        copyKeyCertificate(function(keyErr){
                            if(keyErr){
                                utilLog.log("Error while copying the certificate of type Key");
                                throw new Error(keyErr);
                            }

                            return cb();
                        });
                    });
                });
            }

            function getDb() {
                profile.name = "core_provision";
                mongo = new soajs.mongo(profile2);
                return mongo;
            }

            function copyCACertificate(cb) {

                var fileData = {
                    filename: "CA Certificate",
                    metadata: {
                        platform: 'docker',
                        certType: 'ca',
                        env: {
                            'DASHBOARD':[customFile.deployment.deployDriver.split('.')[1] + "." + customFile.deployment.deployDriver.split('.')[2]]
                        }
                    }
                };

                getDb().getMongoDB(function (error, db) {
                    if(error) {
                        throw new Error(error);
                    }
                    var gfs = Grid(db, getDb().mongodb);
                    var writeStream = gfs.createWriteStream(fileData);
                    var readStream = fs.createReadStream(customFile.deployment.certificates.caCertificate);
                    readStream.pipe(writeStream);

                    writeStream.on('error', function (error) {
                        return cb(error);
                    });
                    writeStream.on('close', function (file) {
                        return cb(null, true);
                    });
                });
            }

            function copyCertCertificate(cb) {

                var fileData = {
                    filename: "Cert Certificate",
                    metadata: {
                        platform: 'docker',
                        certType: 'cert',
                        env: {
                            'DASHBOARD':[customFile.deployment.deployDriver.split('.')[1] + "." + customFile.deployment.deployDriver.split('.')[2]]
                        }
                    }
                };

                getDb().getMongoDB(function (error, db) {
                    if(error) {
                        throw new Error(error);
                    }
                    var gfs = Grid(db, getDb().mongodb);
                    var writeStream = gfs.createWriteStream(fileData);
                    var readStream = fs.createReadStream(customFile.deployment.certificates.certCertificate);
                    readStream.pipe(writeStream);
                    writeStream.on('error', function (error) {
                        return cb(error);
                    });
                    writeStream.on('close', function (file) {
                        return cb(null, true);
                    });
                });
            }

            function copyKeyCertificate(cb) {

                var fileData = {
                    filename: "Key Certificate",
                    metadata: {
                        platform: 'docker',
                        certType: 'key',
                        env: {
                            'DASHBOARD':[customFile.deployment.deployDriver.split('.')[1] + "." + customFile.deployment.deployDriver.split('.')[2]]
                        }
                    }
                };

                getDb().getMongoDB(function (error, db) {
                    if(error) {
                        throw new Error(error);
                    }
                    var gfs = Grid(db, getDb().mongodb);
                    var writeStream = gfs.createWriteStream(fileData);
                    var readStream = fs.createReadStream(customFile.deployment.certificates.keyCertificate);
                    readStream.pipe(writeStream);
                    writeStream.on('error', function (error) {
                        return cb(error);
                    });
                    writeStream.on('close', function (file) {
                        return cb(null, true);
                    });
                });
            }

        });
    },
	
	deployService: function (deployer, options, cb) {
		deployer.createService(options, function () {
			//check if service name elasticsearch to configure it
			if (config.analytics === "true") {
				if (options.Name === 'soajs-analytics-elasticsearch') {
					lib.configureElastic(deployer, options, cb);
				}
				else {
					lib.configureKibana(deployer, options, cb);
				}
			}
			else {
				return cb(null, true);
			}
		});
	},

    deleteService: function (deployer, options, cb) {
        var service = deployer.getService(options.id);
        service.remove(cb);
    },

    deleteContainer: function (deployer, options, cb) {
        var container = deployer.getContainer(options.id);
        container.remove({force: true}, cb);
    },

    deletePreviousServices: function (deployer, cb) {
        var filters = { label: { 'soajs.content': true }};
        deployer.listServices({ filters: filters }, function (error, services) {
            if (error) return cb(error);

            async.each(services, function (oneService, callback) {
                var serviceOptions = {id: oneService.ID};
                lib.deleteService(deployer, serviceOptions, callback);
            }, function (error, result) {
                if (error) return cb(error);

                //force remove containers instead of waiting for them to be automatically removed
                deployer.listContainers({ filters: filters }, function (error, containers) {
                    if (error) return cb(error);

                    async.each(containers, function (oneContainer, callback) {
                        var containerOptions = {id: oneContainer.Id};
                        lib.deleteContainer(deployer, containerOptions, callback);
                    }, cb);
                });
            });
        });
    },
	
	getServiceNames: function (serviceName, deployer, replicaCount, counter, cb) {
		if (typeof (counter) === 'function') {
			cb = counter; //counter wasn't passed as param
			counter = 0;
		}
		var params = {
			filters: {
				label: ['com.docker.swarm.service.name=' + serviceName],
				status: ['running']
			}
		};
		deployer.listContainers(params, function (err, result) {
			if (err) return cb(err);
			
			var oneContainer = [];
			for (var cid in result) {
				
				oneContainer.push({
					name: result[cid].Labels['com.docker.swarm.task.name'].replace('.' + result[cid].Labels['com.docker.swarm.task.id'], '')
				});
			}
			if (oneContainer.length !== replicaCount) {
				//Containers may not have been attached to network yet
				lib.printProgress('Waiting for ' + serviceName + ' containers to become available', counter++);
				setTimeout(function () {
					return lib.getServiceNames(serviceName, deployer, replicaCount, counter, cb);
				}, 1000);
			}
			else {
				
				utilLog.log(""); //intentional, to force writting a new line.
				return cb(null, oneContainer);
			}
		});
	},
	
    getServiceIPs: function (serviceName, deployer, replicaCount, counter, cb) {
        if (typeof (counter) === 'function') {
            cb = counter; //counter wasn't passed as param
            counter = 0;
        }

        var network = deployer.getNetwork(config.docker.network);
        network.inspect(function (error, result) {
            if (error) return cb(error);

            var oneContainer, ips = [];
            for (var cid in result.Containers) {
                oneContainer = result.Containers[cid];
                if (oneContainer.Name.indexOf(serviceName) !== -1) {
                    ips.push({
                        name: oneContainer.Name,
                        ip: oneContainer.IPv4Address.substring(0, oneContainer.IPv4Address.indexOf('/'))
                    });
                }
            }

            if (ips.length !== replicaCount) {
                //Containers may not have been attached to network yet
                lib.printProgress('Waiting for ' + serviceName + ' containers to become available', counter++);
                setTimeout(function () {
                    return lib.getServiceIPs(serviceName, deployer, replicaCount, counter, cb);
                }, 1000);
            }
            else {
                utilLog.log(""); //intentional, to force writting a new line.
                return cb(null, ips);
            }
        });
    },

    addMongoInfo: function (services, mongoInfo, cb) {
        var mongoEnv = [];

        if(config.mongo.prefix && config.mongo.prefix !== ""){
	        mongoEnv.push('SOAJS_MONGO_PREFIX=' + config.mongo.prefix);
        }
        
        if (config.mongo.external) {
	        if(config.mongo.rsName && config.mongo.rsName !== ""){
		        mongoEnv.push('SOAJS_MONGO_RSNAME=' + config.mongo.rsName);
	        }
	        
            // if (!config.dataLayer.mongo.url || !config.dataLayer.mongo.port) {
            if (!profile.servers[0].host || !profile.servers[0].port) {
                utilLog.log('ERROR: External Mongo information is missing URL or port, make sure SOAJS_MONGO_EXTERNAL_URL and SOAJS_MONGO_EXTERNAL_PORT are set ...');
                return cb('ERROR: missing mongo information');
            }
	        
            mongoEnv.push('SOAJS_MONGO_NB=' + profile.servers.length);
            for(var i = 0; i < profile.servers.length; i++){
	            mongoEnv.push('SOAJS_MONGO_IP_' + (i + 1) + '=' + profile.servers[i].host);
	            mongoEnv.push('SOAJS_MONGO_PORT_' + (i + 1) + '=' + profile.servers[i].port);
            }

            if (profile.credentials && profile.credentials.username && profile.credentials.password) {
                mongoEnv.push('SOAJS_MONGO_USERNAME=' + profile.credentials.username);
                mongoEnv.push('SOAJS_MONGO_PASSWORD=' + profile.credentials.password);
                mongoEnv.push('SOAJS_MONGO_AUTH_DB=' + profile.URLParam.authSource);
            }

            if (profile.URLParam.ssl) {
                mongoEnv.push('SOAJS_MONGO_SSL=' + profile.URLParam.ssl);
            }
        }
        else {
        	//only one server in this case, internal mongo container id
	        mongoEnv.push('SOAJS_MONGO_NB=1');
	        mongoEnv.push('SOAJS_MONGO_IP_1=' + profile.servers[0].host);
	        mongoEnv.push('SOAJS_MONGO_PORT_1=' + profile.servers[0].port);
        }

        services.forEach(function (oneService) {
            oneService.TaskTemplate.ContainerSpec.Env = oneService.TaskTemplate.ContainerSpec.Env.concat(mongoEnv);
        });

        return cb(null, services);
    },

    inspectSwarm: function (deployer, cb) {
        deployer.swarmInspect(cb);
    },

    saveSwarmTokens: function (swarmInfo) {
        Object.keys(swarmInfo.JoinTokens).forEach(function (oneType) {
            config.docker.swarmConfig.tokens[oneType.toLowerCase()] = swarmInfo.JoinTokens[oneType];
        });
    },

    prepareSwarmNetwork: function (deployer, cb) {
        var netName = config.docker.network;
        var params = {}, found;
        params.filters = {
            type: {
                custom: true
            }
        };

        deployer.listNetworks(params, function (error, networks) {
            if (error) return cb(error);

            for (var i = 0; i < networks.length; i++) {
                if (networks[i].Name === netName) {
                    found = true;
                    break;
                }
            }

            if (found) {
                utilLog.log(netName + ' network found, proceeding ...');
                return cb(null, true);
            }
            else {
                utilLog.log(netName + ' network not found, creating ...');
                var networkParams = {
                    Name: netName,
                    Driver: 'overlay',
                    Internal: false,
                    CheckDuplicate: true,
                    EnableIPv6: false,
                    IPAM: {
                        Driver: 'default'
                    }
                };

                return deployer.createNetwork(networkParams, cb);
            }
        });
    },
	
	
	configureElastic: function (deployer, serviceOptions, cb) {
		mongo.findOne('analytics', {_type: 'settings'}, function (error, settings) {
			if (error) {
				return cb(error);
			}
			if (settings && settings.elasticsearch && dbConfiguration.dbs.databases[settings.elasticsearch.db_name]) {
				var cluster = dbConfiguration.dbs.databases[settings.elasticsearch.db_name].cluster;
				if (!process.env.SOAJS_INSTALL_DEBUG){
					dbConfiguration.dbs.clusters[cluster].extraParam.log = [{
						type: 'stdio',
						levels: [] // remove the logs
					}];
				}
				esClient = new soajs.es(dbConfiguration.dbs.clusters[cluster]);
				
			}
			else {
				return cb(new Error("No Elastic db name found!"));
			}
			lib.getServiceNames(serviceOptions.Name, deployer, serviceOptions.Mode.Replicated.Replicas, function (error) {
				if (error) return cb(error);
				pingElastic(function (err, esResponse) {
					utilLog.log('Configuring elasticsearch ...');
					async.series({
						"mapping": function (callback) {
							putMapping(callback);
						},
						"template": function (callback) {
							putTemplate(callback);
						},
						"settings": function (callback) {
							putSettings(esResponse, settings, callback);
						}
					}, cb);
				});
			});
		});
		
		function pingElastic(cb) {
			esClient.ping(function (error) {
				if (error) {
					lib.printProgress('Waiting for ' + serviceOptions.Name + ' server to become connected');
					setTimeout(function () {
						pingElastic(cb);
					}, 2000);
				}
				else {
					//delete all indexes
					infoElastic(function (err, response) {
						if (error) {
							cb(err);
						}
						else {
							var params = {
								index: '_all'
							};
							esClient.db.indices.delete(params, function (err) {
								return cb(err, response);
							});
						}
					});
				}
			});
		}
		
		function infoElastic(cb) {
			esClient.db.info(function (error, response) {
				if (error) {
					lib.printProgress('Waiting for ' + serviceOptions.Name + ' server to become available');
					setTimeout(function () {
						infoElastic(cb);
					}, 3000);
				}
				else {
					return cb(null, response);
				}
			});
		}
		
		function putTemplate(cb) {
			mongo.find('analytics', {_type: 'template'}, function (error, templates) {
				if (error) return cb(error);
				async.each(templates, function (oneTemplate, callback) {
					if (oneTemplate._json.dynamic_templates && oneTemplate._json.dynamic_templates["system-process-cgroup-cpuacct-percpu"]) {
						oneTemplate._json.dynamic_templates["system.process.cgroup.cpuacct.percpu"] = oneTemplate._json.dynamic_templates["system-process-cgroup-cpuacct-percpu"];
						delete oneTemplate._json.dynamic_templates["system-process-cgroup-cpuacct-percpu"];
					}
					oneTemplate._json.settings["index.mapping.total_fields.limit"] = oneTemplate._json.settings["index-mapping-total_fields-limit"];
					oneTemplate._json.settings["index.refresh_interval"] = oneTemplate._json.settings["index-refresh_interval"];
					delete oneTemplate._json.settings["index-refresh_interval"];
					delete oneTemplate._json.settings["index-mapping-total_fields-limit"];
					var options = {
						'name': oneTemplate._name,
						'body': oneTemplate._json
					};
					esClient.db.indices.putTemplate(options, function (error) {
						return callback(error, true);
					});
				}, cb);
			});
		}
		
		function putMapping(cb) {
			mongo.findOne('analytics', {_type: 'mapping'}, function (error, mapping) {
				if (error) return cb(error);
				var mappings = {
					index: '.kibana',
				};
				esClient.db.indices.exists(mappings, function (error, result) {
					if (error || !result) {
						mappings = {
							index: '.kibana',
							body: {
								"mappings": mapping._json
							}
						};
						esClient.db.indices.create(mappings, function (error) {
							return cb(error, true);
						});
					}
					else {
						return cb(null, true);
					}
				});
			});
		}
		
		function putSettings(esResponse, settings, cb) {
			settings.env = {
				"dashboard": true
			};
			settings.elasticsearch.status = "deployed";
			settings.elasticsearch.version = esResponse.version.number;
			mongo.save('analytics', settings, function (error) {
				if (error) {
					return cb(error);
				}
				return cb(null, true)
			});
		}
		
	},
	
	configureKibana: function (deployer, serviceOptions, cb) {
		var dockerServiceName = serviceOptions.Name;
		var serviceGroup, serviceName, serviceEnv, serviceType;
		
		if (serviceOptions.Labels) {
			serviceGroup = serviceOptions.Labels['soajs.service.group'];
			serviceName = serviceOptions.Labels['soajs.service.repo.name'];
			serviceEnv = serviceOptions.Labels['soajs.env.code'];
		}
		if (serviceGroup === 'soajs-core-services') {
			serviceType = (serviceName === 'soajs_controller') ? 'controller' : 'service';
		}
		else if (serviceGroup === 'nginx') {
			serviceType = 'nginx';
			serviceName = 'nginx';
		}
		else {
			return cb(null, true);
		}
		serviceEnv.replace(/[\/*?"<>|,.-]/g, "_");
		var replicaCount = serviceOptions.Mode.Replicated.Replicas;
		utilLog.log('Fetching analytics for ' + serviceName);
		var analyticsArray = [];
		async.parallel({
			"filebeat": function (callback) {
				lib.getServiceNames(dockerServiceName, deployer, replicaCount, function (error, serviceIPs) {
					if (error) return cb(error);
					var options = {
						"$and": [
							{
								"_type": {
									"$in": ["dashboard", "visualization", "search"]
								}
							},
							{
								"_service": serviceType
							}
						]
						
					};
					
					//insert index-patterns to kibana
					serviceIPs.forEach(function (task_Name, key) {
						task_Name.name = task_Name.name.replace(/[\/*?"<>|,.-]/g, "_");
						
						//filebeat-service-environment-taskname-*
						var filebeatIndex = require("../analytics/indexes/filebeat-index");
						// var allIndex = require("../analytics/indexes/all-index");
						// analyticsArray = analyticsArray.concat(
						// 	[
						// 		{
						// 			index: {
						// 				_index: '.kibana',
						// 				_type: 'index-pattern',
						// 				_id: 'filebeat-' + serviceName + "-" + serviceEnv + "-" + task_Name.name + "-" + "*"
						// 			}
						// 		},
						// 		{
						// 			title: 'filebeat-' + serviceName + "-" + serviceEnv + "-" + task_Name.name + "-" + "*",
						// 			timeFieldName: '@timestamp',
						// 			fields: filebeatIndex.fields,
						// 			fieldFormatMap: filebeatIndex.fieldFormatMap
						// 		}
						// 	]
						// );
						
						// analyticsArray = analyticsArray.concat(
						// 	[
						// 		{
						// 			index: {
						// 				_index: '.kibana',
						// 				_type: 'index-pattern',
						// 				_id: '*-' + serviceName + "-" + serviceEnv + "-" + task_Name.name + "-" + "*"
						// 			}
						// 		},
						// 		{
						// 			title: '*-' + serviceName + "-" + serviceEnv + "-" + task_Name.name + "-" + "*",
						// 			timeFieldName: '@timestamp',
						// 			fields: allIndex.fields,
						// 			fieldFormatMap: allIndex.fieldFormatMap
						// 		}
						// 	]
						// );
						
						
						if (key == 0) {
							//filebeat-service-environment-*
							
							analyticsArray = analyticsArray.concat(
								[
									{
										index: {
											_index: '.kibana',
											_type: 'index-pattern',
											_id: 'filebeat-' + serviceName + "-" + serviceEnv + "-" + "*"
										}
									},
									{
										title: 'filebeat-' + serviceName + "-" + serviceEnv + "-" + "*",
										timeFieldName: '@timestamp',
										fields: filebeatIndex.fields,
										fieldFormatMap: filebeatIndex.fieldFormatMap
									}
								]
							);
							
							
							// analyticsArray = analyticsArray.concat(
							// 	[
							// 		{
							// 			index: {
							// 				_index: '.kibana',
							// 				_type: 'index-pattern',
							// 				_id: '*-' + serviceName + "-" + serviceEnv + "-" + "*"
							// 			}
							// 		},
							// 		{
							// 			title: '*-' + serviceName + "-" + serviceEnv + "-" + "*",
							// 			timeFieldName: '@timestamp',
							// 			fields: allIndex.fields,
							// 			fieldFormatMap: allIndex.fieldFormatMap
							// 		}
							// 	]
							// );
							
							//filebeat-service-environment-*
							
							
							// analyticsArray = analyticsArray.concat(
							// 	[
							// 		{
							// 			index: {
							// 				_index: '.kibana',
							// 				_type: 'index-pattern',
							// 				_id: 'filebeat-' + serviceName + '-' + "*"
							// 			}
							// 		},
							// 		{
							// 			title: 'filebeat-' + serviceName + '-' + "*",
							// 			timeFieldName: '@timestamp',
							// 			fields: filebeatIndex.fields,
							// 			fieldFormatMap: filebeatIndex.fieldFormatMap
							// 		}
							// 	]
							// );
							
							// analyticsArray = analyticsArray.concat(
							// 	[
							// 		{
							// 			index: {
							// 				_index: '.kibana',
							// 				_type: 'index-pattern',
							// 				_id: '*-' + serviceName + "-" + "*"
							// 			}
							// 		},
							// 		{
							// 			title: '*-' + serviceName + "-" + "*",
							// 			timeFieldName: '@timestamp',
							// 			fields: allIndex.fields,
							// 			fieldFormatMap: allIndex.fieldFormatMap
							// 		}
							// 	]
							// );
						}
					});
					
					//insert visualization, search and dashboard records per service to kibana
					mongo.find(analyticsCollection, options, function (error, records) {
						if (error) {
							return callback(error);
						}
						records.forEach(function (oneRecord) {
							if (Array.isArray(serviceIPs) && serviceIPs.length > 0) {
								serviceIPs.forEach(function (task_Name) {
									task_Name.name = task_Name.name.replace(/[\/*?"<>|,.-]/g, "_");
									var serviceIndex;
									if (oneRecord._type === "visualization" || oneRecord._type === "search") {
										serviceIndex = serviceName + "-";
										if (oneRecord._injector === "service") {
											serviceIndex = serviceIndex + serviceEnv + "-" + "*";
										}
										else if (oneRecord._injector === "env") {
											serviceIndex = "*-" + serviceEnv + "-" + "*";
										}
										else if (oneRecord._injector === "taskname") {
											serviceIndex = serviceIndex + serviceEnv + "-" + task_Name.name + "-" + "*";
										}
									}
									
									var injector;
									if (oneRecord._injector === 'service') {
										injector = serviceName + "-" + serviceEnv;
									}
									else if (oneRecord._injector === 'taskname') {
										injector = task_Name.name;
									}
									else if (oneRecord._injector === 'env') {
										injector = serviceEnv;
									}
									oneRecord = JSON.stringify(oneRecord);
									if (serviceIndex) {
										oneRecord = oneRecord.replace(/%serviceIndex%/g, serviceIndex);
									}
									if (injector) {
										oneRecord = oneRecord.replace(/%injector%/g, injector);
									}
									oneRecord = oneRecord.replace(/%env%/g, serviceEnv);
									oneRecord = JSON.parse(oneRecord);
									var recordIndex = {
										index: {
											_index: '.kibana',
											_type: oneRecord._type,
											_id: oneRecord.id
										}
									};
									analyticsArray = analyticsArray.concat([recordIndex, oneRecord._source]);
								});
							}
						});
						return callback(null, true);
					});
				});
			},
			"metricbeat": function (callback) {
				var metricbeatIndex = require("../analytics/indexes/metricbeat-index");
				var filebeatIndex= require("../analytics/indexes/filebeat-index");
				analyticsArray = analyticsArray.concat(
					[
						{
							index: {
								_index: '.kibana',
								_type: 'index-pattern',
								_id: 'metricbeat-*'
							}
						},
						{
							title: 'metricbeat-*',
							timeFieldName: '@timestamp',
							fields: metricbeatIndex.fields,
							fieldFormatMap: metricbeatIndex.fieldFormatMap
						}
					]
				);
				
				analyticsArray = analyticsArray.concat(
					[
						{
							index: {
								_index: '.kibana',
								_type: 'index-pattern',
								_id: 'filebeat-*-' + serviceEnv + "-*"
							}
						},
						{
							title: 'filebeat-*-' + serviceEnv + "-*",
							timeFieldName: '@timestamp',
							fields: filebeatIndex.fields,
							fieldFormatMap: filebeatIndex.fieldFormatMap
						}
					]
				);
				var condition = {
					"_shipper": "metricbeat"
				};
				mongo.find(analyticsCollection, condition, function (error, records) {
					if (error) {
						return callback(error);
					}
					if (records && records.length > 0) {
						records.forEach(function(onRecord){
							onRecord = JSON.stringify(onRecord);
							onRecord = onRecord.replace(/%env%/g, serviceEnv);
							onRecord = JSON.parse(onRecord);
							var recordIndex = {
								index: {
									_index: '.kibana',
									_type: onRecord._type,
									_id: onRecord.id
								}
							};
							analyticsArray = analyticsArray.concat([recordIndex, onRecord._source]);
						});
						
					}
					return callback(null, true);
					
				});
			}
		}, function (err) {
			if (err) {
				return cb(err);
			}
			function esBulk(array, cb) {
				esClient.bulk(array, function (error, response) {
					if (error) {
						return cb(error);
					}
					return cb(null, response);
				});
			}
			
			if (analyticsArray.length !== 0) {
				esClient.checkIndex('.kibana', function (error, response) {
					if (error) {
						return cb(error);
					}
					if (response) {
						esBulk(analyticsArray, cb);
					}
					else {
						esClient.createIndex('.kibana', function (error) {
							if (error) {
								return cb(error);
							}
							esBulk(analyticsArray, cb);
						})
					}
				});
			}
			else {
				return cb(null, true);
			}
		});
	},
	
	setDefaultIndex: function (cb) {
		var index = {
			index: ".kibana",
			type: 'config',
			body: {
				doc: {"defaultIndex": "metricbeat-*"}
			}
		};
		var condition = {
			index: ".kibana",
			type: 'config'
		};
		esClient.db.search(condition, function (err, res) {
			if (err) {
				return cb(err);
			}
			if (res && res.hits && res.hits.hits && res.hits.hits.length > 0) {
				mongo.findOne(analyticsCollection, {"_type": "settings"}, function (err, result) {
					if (err) {
						return cb(err);
					}
					if (result && result.env && result.env.dashboard) {
						index.id = res.hits.hits[0]._id;
						
						async.parallel({
							"updateES": function (call) {
								esClient.db.update(index, call);
							},
							"updateSettings": function (call) {
								var condition = {
									"_type": "settings"
								};
								var criteria = {
									"$set": {
										"kibana": {
											"version": index.id,
											"status": "deployed",
											"port": "32601"
										},
										"logstash": {
											"dashboard": {
												"status": "deployed"
											}
										},
										"filebeat": {
											"dashboard": {
												"status": "deployed"
											}
										},
										"metricbeat": {
											"status": "deployed"
										}
									}
								};
								var options = {
									"safe": true,
									"multi": false,
									"upsert": true
								};
								mongo.update('analytics', condition, criteria, options, call);
							}
						}, cb);
					}
					else {
						return cb(null, true);
					}
				});
			}
			else {
				setTimeout(function () {
					lib.printProgress('Waiting for kibana to become available');
					lib.setDefaultIndex(cb);
				}, 1000);
			}
		});
		
	},
	
	closeDbCon: function (cb) {
		mongo.closeDb();
		if (esClient) {
			esClient.close();
		}
		return cb();
	}
};

module.exports = lib;
