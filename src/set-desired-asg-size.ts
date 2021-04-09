/**
 * This lambda will update the Auto Scaling Group size to the desired capacity when invoked
 */
import { Context, SNSEvent } from 'aws-lambda';
import * as AWS from 'aws-sdk';

const DESIRED_ASG_SIZE = process.env['DESIRED_ASG_SIZE'];
const ASG_GROUP_NAME = process.env['ASG_GROUP_NAME'];
const REGION = process.env['REGION'];

console.log(`DESIRED_ASG_SIZE is ${DESIRED_ASG_SIZE}`);
console.log(`ASG_GROUP_NAME is ${ASG_GROUP_NAME}`);

const autoscalingClient = new AWS.AutoScaling({
    region: REGION,
});

export async function handler(
    event: SNSEvent,
    context: Context
): Promise<Record<string, unknown>> {
    console.log(`Received event: ${JSON.stringify(event, undefined, 4)}`);

    try {
        const response = await autoscalingClient
            .updateAutoScalingGroup({
                AutoScalingGroupName: ASG_GROUP_NAME!,
                DesiredCapacity: Number(DESIRED_ASG_SIZE!),
            })
            .promise();

        console.log(response);

        return {
            status: 200,
            body: `Successfully updated auto scaling group ${ASG_GROUP_NAME} to DesiredCapacity ${DESIRED_ASG_SIZE}`,
        };
    } catch (e) {
        console.error(
            `Failed to update auto scaling group ${ASG_GROUP_NAME} settings`,
            e
        );
        throw e;
    }
}
