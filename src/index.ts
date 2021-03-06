import http from 'http';
import { AddressInfo } from 'net';

// tslint:disable-next-line no-var-requires
const k8s = require('auto-kubernetes-client');
import { EC2 } from 'aws-sdk';
import express from 'express';
import prometheusBundle from 'express-prom-bundle';
import { getLogger, configure } from 'log4js';
import yargs from 'yargs';

// tslint:disable-next-line no-var-requires
const pkg = require('../package.json');
import { createK8sConfig } from './k8-config';

type Pod = any;

configure(process.env.LOG4JS_CONFIG || 'log4js.json');
const logger = getLogger(pkg.name);

const argv = yargs
	.alias('s', 'server').describe('server', 'The address and port of the Kubernetes API server')
	.alias('cacert', 'certificate-authority').describe('certificate-authority', 'Path to a cert. file for the certificate authority')
	.alias('cert', 'client-certificate').describe('client-certificate', 'Path to a client certificate file for TLS')
	.alias('key', 'client-key').describe('client-key', 'Path to a client key file for TLS')
	.boolean('insecure-skip-tls-verify').describe('insecure-skip-tls-verify', 'If true, the server\'s certificate will not be checked for validity. This will make your HTTPS connections insecure')
	.describe('token', 'Bearer token for authentication to the API server')
	.describe('namespace', 'The namespace to watch').string('namespace').demandOption('namespace')
	.array('resource-type').describe('resource-type', 'Enabled resource types (empty to enable all, can use multiple times)').default('resource-type', [])
	.number('port').default('port', process.env.PORT || 8080)
	.help()
	.argv;


const ANNOTATIONS = [
	'ec2.amazonaws.com/availability-zone',
	'ec2.amazonaws.com/availability-zone-id',
];

function initMonitoring() {
	return prometheusBundle({
		promClient: {
			collectDefaultMetrics: {},
		},
	});
}

/**
 * Log whether the given promise resolved successfully or not.
 *
 * @param name the name of the entity that the promise actually modifies
 * @param promise a promise
 * @return nothing
 */
function logOperationResult(name: string, promise: Promise<any>): Promise<void> {
	return promise.then(data => {
		logger.info(`${name}: Success ${JSON.stringify(data)}`);
	}, err => {
		logger.error(`${name}: Error ${err.message} (${err.code})`);
	});
}

async function updateAnnotations(coreV1: any, pod: Pod, availabilityZones: EC2.AvailabilityZone[]) {
	function makeResult(status: string, annotations: {[key: string]: string}) {
		return {
			status,
			annotations: ANNOTATIONS.reduce((result, annotation) => ({...result, [annotation]: annotations[annotation]}), {}),
		}
	}

	const podName = `${pod.metadata.namespace}/${pod.metadata.name}`;
	if (ANNOTATIONS.every(annotation => pod.metadata.annotations[annotation])) {
		// Find, everything there.
		// Pods don't move around nodes, so if we have the annotations set once, we can leave them.
		logger.trace(`${podName}: Found existing annotations, skipping update`);
		return makeResult('current', pod.metadata.annotations);
	}

	// Check whether we have a nodeName set
	// It seems that this may not necessarily be there in the beginning when the pod resource is getting
	// moved through admission controllers and getting scheduled. We just ignore that silently.
	const nodeName = pod.spec.nodeName;
	if (!nodeName) {
		logger.trace(`${podName}: Missing nodeName, skipping (${JSON.stringify(pod)})`);
		return makeResult('missing-node-name', pod.metadata.annotations);
	}

	// TODO: Two options here
	// 1. We can get the region annotation from the node
	// 2. We can try to find the node by name through the EC2 metadata
	// The second option is "more costly", given that we would have to call the EC2 API constantly.
	const node = await coreV1.node(nodeName).get();
	if (!node) {
		// XXX: Should we blacklist this pod/node/...?
		logger.warn(`${podName}: Cannot GET node ${nodeName}`);
		return makeResult('unavailable-node', pod.metadata.annotations);
	}

	// Use the 1.17+ 'topology.kubernetes.io/zone', and fall-back to the pre-1.17 'failure-domain.beta.kubernetes.io/zone'.
	// https://kubernetes.io/docs/reference/kubernetes-api/labels-annotations-taints/#topologykubernetesiozone
	const availabilityZoneName = node.metadata.labels['topology.kubernetes.io/zone'] ?? node.metadata.labels['failure-domain.beta.kubernetes.io/zone'];
	if (!availabilityZoneName) {
		logger.warn(`${podName}: Neither topology.kubernetes.io/zone nor failure-domain.beta.kubernetes.io/zone label on node ${nodeName}`);
		return makeResult('missing-failure-domain-zone', pod.metadata.annotations);
	}

	// Start building up the patch
	const operations = [];
	operations.push({
		op: 'add',
		path: '/metadata/annotations/ec2.amazonaws.com~1availability-zone',
		value: availabilityZoneName,
	});

	// Look up the zone id
	const availabilityZone = availabilityZones.find(az => az.ZoneName === availabilityZoneName);
	if (!availabilityZone) {
		logger.warn(`${podName}: Unknown availability zone ${availabilityZoneName}`);
	} else {
		operations.push({
			op: 'add',
			path: '/metadata/annotations/ec2.amazonaws.com~1availability-zone-id',
			value: availabilityZone.ZoneId,
		});
	}

	// Apply the patches
	logger.debug(`${podName}: Applying ${JSON.stringify(operations)}`);
	const updated = await coreV1.ns(pod.metadata.namespace).pod(pod.metadata.name).patch(operations, 'application/json-patch+json');
	return makeResult('updated', updated.metadata.annotations);
}

async function resourceLoop(coreV1: any, namespace: string, ec2: EC2, onUpdate: (pod: Pod, availabilityZones: EC2.AvailabilityZone[]) => Promise<any>) {
	const pods = coreV1.ns(namespace).pods;
	const list = await pods.list();
	const resourceVersion = list.metadata.resourceVersion;

	// Query the zones in each loop, so we "eventually" will handle changes
	const { AvailabilityZones: availabilityZones } = await ec2.describeAvailabilityZones().promise();

	// Process existing items and check that they have the correct annotation.
	// If not: Schedule them for processing.
	const pending: Pod[] = [];
	for (const resource of list.items) {
		if (!ANNOTATIONS.every(annotation => resource.metadata.annotations[annotation])) {
			pending.push(resource);
		}
	}
	setImmediate(() => {
		for (const resource of pending) {
			const name = `${resource.metadata.namespace}/${resource.metadata.name}`;
			logOperationResult(name, onUpdate(resource, availabilityZones!));
		}
	});

	// Start watching the resources from that version on
	logger.info(`Watching pods at ${resourceVersion}...`);
	pods.watch(resourceVersion)
		.on('data', (item: any) => {
			const resource = item.object;
			const name = `${resource.metadata.namespace}/${resource.metadata.name}`;

			let result: Promise<void>|undefined;
			switch (item.type) {
			case 'ADDED':
			case 'MODIFIED':
				result = onUpdate(resource, availabilityZones!);
				break;
			case 'DELETED':
				// Don't care
				break;
			case 'ERROR':
				// Log the message, and continue: usually the stream would end now, but there might be more events
				// in it that we do want to consume.
				logger.warn(`Error while watching: ${item.object.message}, ignoring`);
				return;
			default:
				logger.warn(`Unknown watch event type ${item.type}, ignoring`);
				return;
			}

			if (result) {
				// We're not waiting for the result here, and simply assume that
				// it will apply "eventually"
				logOperationResult(name, result);
			}
		})
		.on('end', () => {
			// Restart the watch from the last known version.
			logger.info(`Watch of pods ended, restarting`);
			resourceLoop(coreV1, namespace, ec2, onUpdate);
		});
}

async function main() {
	const ec2 = new EC2({
		endpoint: process.env.AWS_EC2_ENDPOINT_URL_OVERRIDE,
		region: process.env.AWS_REGION,
	});

	// Set up the express server for /metrics etc.
	const app = express();
	app.use(initMonitoring());

	const server = http.createServer(app);
	const listener = server.listen(argv.port, async () => {
		try {
			const k8sConfig = createK8sConfig(argv);
			const k8sClient = await k8s(k8sConfig);
			const coreV1 = k8sClient.group('', 'v1');

			const onUpdate = async (pod: Pod, availabilityZones: EC2.AvailabilityZone[]) => {
				return updateAnnotations(coreV1, pod, availabilityZones);
			};

			const resourceLoopPromise = resourceLoop(coreV1, argv.namespace, ec2, onUpdate).catch(err => {
				logger.error(`Error when monitoring pods: ${err.message}`);
				throw err;
			});

			// XXX: The loop will start now, but it might fail quickly if something goes wrong.
			//      For the purposes of logging things though we're "ready" now.
			const addressInfo: AddressInfo = listener.address()! as AddressInfo;
			logger.info(`${pkg.name} ${pkg.version} ready on port ${addressInfo.port}`);

			return resourceLoopPromise;
		} catch (err) {
			logger.error(`Uncaught error, aborting: ${err.message}`);
			process.exit(1);
		}
	});
}

main();