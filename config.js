"use strict";

module.exports = {
	type: 'service',
	prerequisites: {
		cpu: '',
		memory: ''
	},
	serviceVersion: 1,
	serviceName: "installer",
	serviceGroup: "SOAJS Installer",
	requestTimeout: 30,
	requestTimeoutRenewal: 5,
	servicePort: 1337,
	extKeyRequired: false,
	"errors": {},
	"schema": {
		'get': {
			'/overview' :{
				"_apiInfo":{
					"l": "Load Overview"
				}
			},
			'/installer/gi' :{
				"_apiInfo":{
					"l": "Load General Information"
				}
			},
			'/installer/security' :{
				"_apiInfo":{
					"l": "load Security Information"
				}
			},
			'/installer/clusters' :{
				"_apiInfo":{
					"l": "Load Clusters Information"
				}
			},
			'/installer/deployment' :{
				"_apiInfo":{
					"l": "Load Deployment Information"
				}
			},
			'/installer/go' :{
				"_apiInfo":{
					"l": "Proceed with Installing SOAJS"
				}
			},
			'/progress/info' :{
				"_apiInfo":{
					"l": "Return Installation Progress Information"
				}
			},
			'/progress' :{
				"_apiInfo":{
					"l": "Return Installation Progress"
				}
			}
		},
		'post': {
			'/overview' :{
				"_apiInfo":{
					"l": "Fill Overview"
				},
				'overview': {
					"source":['body.overview'],
					"required": false,
					'validation':{
						"type": "object",
						"properties": {
							"deployType" : {"type": "string", "required": true, "enum": ["manual", "container"]},
							"deployDriver": {
								"type": "string",
								"required": true,
								"enum": ["manual", "container.docker.local", "container.docker.remote", "container.kubernetes.local", "container.kubernetes.remote"]
							},
							"deployAnalytics": {"type": "boolean", "required": false},
							"remoteProvider": {
								"type": "object",
								"required": false,
								"properties": {
									"name": { "type": "string", "required": true},
									"label": { "type": "string", "required": true},
									"url": { "type": "string", "required": true}
								}
							}
						},
						"additionalProperties": false
					}
				}
			},
			'/installer/gi' :{
				"_apiInfo":{
					"l": "Override General Information"
				},
				'gi': {
					"source":['body.gi'],
					"required": false,
					'validation':{
						"type": "object",
						"properties": {
							"api": {"type": "string", "required": false},
							"site": {"type": "string", "required": false},
							"domain": {"type": "string", "required": false, "format": "hostname"},
							"wrkDir": {"type": "string", "required": false, "pattern": /^\/[_a-zA-Z\/][_a-zA-Z0-9\/:]*$/},
							"username": {"type": "string", "required": false},
							"email": {"type": "string", "required": false, "format": "email"},
							"password": {"type": "string", "required": false}
						},
						"additionalProperties": false
					}
				}
			},
			'/installer/security' :{
				"_apiInfo":{
					"l": "Override Security Information"
				},
				'security':{
					'source': ['body.security'],
					'required': false,
					'validation':{
						"type": "object",
						"properties": {
							"key": {"type": "string", "required": false},
							"cookie": {"type": "string", "required": false},
							"session": {"type": "string", "required": false}
						},
						"additionalProperties": false
					}
				}
			},
			'/installer/clusters' :{
				"_apiInfo":{
					"l": "Override Mongo Clusters Information"
				},
				"clusters": {
					"source": ["body.clusters"],
					"required": false,
					"validation":{
						"type": "object",
						"properties": {
							"prefix": {"type": "string"},
							"replicaSet": {"type": "string"},
							"isReplica":{"type":"boolean", "required": false},
                            "mongoExt": {"type": "boolean", "required": false},
							"servers": {
								"type": "array",
								"required": false,
								"items": {
									"host": {"type": "string", "required": true},
									"port": {"type": "number", "required": true, "min": 0},
								},
								"minItems": 1,
								"uniqueItems": true
							},
							"credentials": {
								"type": "object",
								"properties": {
									"username": {"type": "string"},
									"password": {"type": "string"}
								}
							},
							"URLParam": {"type": "object", "properties": {}},
							"extraParam": {"type": "object", "properties": {}},
							"streaming": {"type": "object", "properties": {}}
						},
						"additionalProperties": false
					}
				}
			},
			'/installer/esClusters' :{
				"_apiInfo":{
					"l": "Override ElasticSeaach Clusters Information"
				},
				"es_clusters": {
					"source": ["body.es_clusters"],
					"required": false,
					"validation":{
						"type": "object",
						"properties": {
							"es_Ext": {"type": "boolean", "required": false},
							"servers": {
								"type": "array",
								"required": false,
								"items": {
									"host": {"type": "string", "required": true},
									"port": {"type": "number", "required": true, "min": 0},
								},
								"minItems": 1,
								"uniqueItems": true
							},
							"credentials": {
								"type": "object",
								"required": false,
								"properties": {
									"username": {"type": "string"},
									"password": {"type": "string"}
								}
							},
							"URLParam": {"type": "object", "properties": {}},
							"extraParam": {"type": "object", "properties": {}}
						},
						"additionalProperties": false
					}
				}
			},
			'/installer/deployment' :{
				"_apiInfo":{
					"l": "Override Deployment Information"
				},
				"deployment": {
					"source":["body.deployment"],
					"required": true,
					"validation":{
						"type": "object",
						"properties": {
							"deployType" : {"type": "string", "required": true, "enum": ["manual", "container"]},
							"deployDriver": {
								"type": "string",
								"required": true,
								"enum": ["manual", "container.docker.local", "container.docker.remote", "container.kubernetes.local", "container.kubernetes.remote"]
							},
							"containerDir": {"type": "string", "required": false},
							"containerHost": {"type": "string", "required": false},
							"deployDockerNodes": {"type": "array", "required": false, "items": {"type": "string"}},

                            "gitSource": {"type": "string", "required": false, "enum": ['github','bitbucket']},
                            "gitProvider": {"type": "string", "required": false},
							"deployAnalytics": {"type": "boolean", "required": false},
                            "gitOwner": {"type": "string", "required": false},
                            "gitRepo": {"type": "string", "required": false},
                            "gitBranch": {"type": "string", "required": false},
                            "gitToken": {"type": "string", "required": false},
                            "gitPath": {"type": "string", "required": false},

                            "imagePrefix": {"type": "string", "required": false},
                            "nginxPort": {"type": "number", "required": false},
                            "nginxSecurePort": {"type": "number", "required": false},
                            "mongoExposedPort": {"type": "number", "required": false},
                            "nginxSsl": {"type": "boolean", "required": false},
                            "generateSsc": {"type": "boolean", "required": false},
							"nginxKubeSecret": {"type": "string", "required": false},
							"nginxDeployType": {"type": "string", "required": false, "enum": ["NodePort", "LoadBalancer"]},

                            "dockerSocket": {"type": "string", "required": false},
                            "networkName": {"type": "string", "required": false},
                            "containerPort": {"type": "number", "required": false},
                            "dockerInternalPort": {"type": "number", "required": false},
                            "dockerReplica": {"type": "number", "required": false},
                            "certificatesFolder": {"type": "string", "required": false},
                            "kubeContainerPort": {"type": "number", "required": false},

                            "certsRequired": {"type": "boolean", "required": false},
							"certificates": {"type": "object", "required": false},
                            "caCertificate": {"type": "string", "required": false},
                            "certCertificate": {"type": "string", "required": false},
                            "keyCertificate": {"type": "string", "required": false},

                            "readinessProbe": {
                                "required": false,
                                "validation": {
                                    "type": "object",
                                    "properties": {
                                        "initialDelaySeconds": {"type": "number", "required": false},
                                        "timeoutSeconds": {"type": "number", "required": false},
                                        "periodSeconds": {"type": "number", "required": false},
                                        "failureThreshold": {"type": "number", "required": false},
                                    }
                                }

                            },
							"namespaces": {
								"required": false,
								"validation": {
									"type": "object",
									"properties": {
										"default": { "type": "string", "required": false },
										"perService": { "type": "boolean", "required": false }
									}
								}
							},
                            "authentication": {
                                "required": false,
                                "validation": {
                                    "type": "object",
                                    "properties": {
                                        "accessToken": { "type": "string", "required": false },
                                    }
                                }
                            }
						},
						"additionalProperties": false
					}
				}
			}
		}
	}
};
