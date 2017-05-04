'use strict';
var gConfig = require("../../config.js");

var components = {
	service: {
		"apiVersion": "v1",
		"kind": "Service",
		"metadata": {
			"name": "dashboard-logstash",
			"labels": {
				"soajs.content": "true",
				"soajs.env.code": "dashboard",
				"soajs.service.name": "dashboard-logstash",
				"soajs.service.group": "elk",
				"soajs.service.label": "dashboard-logstash"
			}
		},
		"spec": {
			"selector": {
				"soajs.service.label": "dashboard-logstash"
			},
			"ports": [
				{
					"port": 12201,
					"targetPort": 12201
				}
			]
		}
	},
	deployment: {
		"apiVersion": "extensions/v1beta1",
		"kind": "Deployment",
		"metadata": {
			"name": "dashboard-logstash",
			"labels": {
				"soajs.content": "true",
				"soajs.env.code": "dashboard",
				"soajs.service.type": "elk",
				"soajs.service.name": "dashboard-logstash",
				"soajs.service.group": "elk",
				"soajs.service.label": "dashboard-logstash"
			}
		},
		"spec": {
			"replicas": gConfig.kubernetes.replicas,
			"selector": {
				"matchLabels": {
					"soajs.service.label": "dashboard-logstash"
				}
			},
			"template": {
				"metadata": {
					"name": "dashboard-logstash",
					"labels": {
						"soajs.content": "true",
						"soajs.env.code": "dashboard",
						"soajs.service.type": "elk",
						"soajs.service.name": "dashboard-logstash",
						"soajs.service.group": "elk",
						"soajs.service.label": "dashboard-logstash"
					}
				},
				"spec": {
					"containers": [
						{
							"name": "dashboard-logstash",
							//"image": gConfig.imagePrefix + "/logstash",
							"image": "soajstest" + "/logstash",
							"imagePullPolicy": "IfNotPresent",
							"command": [
								"bash",
								"-c",
								"logstash -f /usr/share/logstash/config/logstash.conf"
							],
							"ports": [],
							"env": [
								{
									"name": "ELASTICSEARCH_URL",
									"value": "soajs-analytics-elasticsearch:9200"
								}
							]
						}
					]
				}
			}
		}
	}
};

module.exports = components;
