#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import * as events from '@aws-cdk/aws-events';
import { OpenVpnAccessServerInfraStack } from '../lib/openvpn-access-server-infra-stack';

const app = new cdk.App();
new OpenVpnAccessServerInfraStack(app, 'OpenVpnAccessServerInfraStack', {
    env: {
        account:
            process.env.CDK_DEPLOY_ACCOUNT || process.env.CDK_DEFAULT_ACCOUNT,
        region: process.env.CDK_DEPLOY_REGION || process.env.CDK_DEFAULT_REGION,
    },
    description: `Stack that creates a self hosted OpenVPN Access Server and PiHole DNS instance for secure, anonymous and ad-free internet access`,
    // Create a scale up rule for scaling up OpenVPN at 7.45am Malaysian Time (note that the time is converted to UTC)
    addCapacitySchedule: events.Schedule.expression(`cron(45 23 * * ? *)`),
    // Create a scale down rule  for scaling down OpenVPN at 2am Malaysian Time (note that the time is converted to UTC)
    removeCapacitySchedule: events.Schedule.expression(`cron(0 18 * * ? *)`),
    
    /* For more information, see https://docs.aws.amazon.com/cdk/latest/guide/environments.html */
});
