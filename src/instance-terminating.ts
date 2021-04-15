import { AutoScaling, SSM, ACM } from 'aws-sdk';
import { Context, SNSEvent } from 'aws-lambda';

const REGION = process.env['REGION'];
const DOCUMENT_NAME = process.env['DOCUMENT_NAME'];

const autoscaling = new AutoScaling({
    region: REGION,
});

const ssm = new SSM({
    region: REGION,
});

const acm = new ACM({
    region: REGION,
});

export type InstanceTerminatingNotification = {
    readonly Origin: string;
    readonly LifecycleHookName: string;
    readonly Destination: string;
    readonly AccountId: string;
    readonly RequestId: string;
    readonly LifecycleTransition: string;
    readonly AutoScalingGroupName: string;
    readonly Service: string;
    readonly Time: string;
    readonly EC2InstanceId: string;
    readonly LifecycleActionToken: string;
};

export async function handler(
    event: SNSEvent,
    context: Context
): Promise<Record<string, unknown>> {
    console.log(
        `Received auto scaling lifecyle function hook event`,
        JSON.stringify(event, undefined, 4)
    );

    const { Records } = event;
    const [Record, ...rest] = Records ?? [];
    const { Sns } = Record ?? {};
    const { Message } = Sns ?? {};

    // {
    //     "Origin": "AutoScalingGroup",
    //     "LifecycleHookName": "openvpn-instance-termination-lifecycle-hook",
    //     "Destination": "EC2",
    //     "AccountId": "123552021017",
    //     "RequestId": "5487e9ac-efe3-4df3-8dd4-1549237aa99a",
    //     "LifecycleTransition": "autoscaling:EC2_INSTANCE_TERMINATING",
    //     "AutoScalingGroupName": "OpenVpnAccessServerInfraStack-asg-openvpn",
    //     "Service": "AWS Auto Scaling",
    //     "Time": "2021-04-15T16:41:59.710Z",
    //     "EC2InstanceId": "i-0242f2f4a3f027b85",
    //     "LifecycleActionToken": "61579bd3-de96-4341-b773-b4b961e0f6e1"
    // }

    if (typeof Message !== 'undefined') {
        try {
            const parsedMessage = JSON.parse(
                Message
            ) as InstanceTerminatingNotification;

            console.log(
                `Received msg: ${JSON.stringify(Message, undefined, 4)}`
            );

            const params = {
                AutoScalingGroupName:
                    parsedMessage.AutoScalingGroupName /* required */,
                LifecycleActionResult: 'CONTINUE' /* required */,
                LifecycleHookName:
                    parsedMessage.LifecycleHookName /* required */,
                InstanceId: parsedMessage.EC2InstanceId,
                LifecycleActionToken: parsedMessage.LifecycleActionToken,
            };

            // run cleanup action

            try {
                const result = await autoscaling
                    .completeLifecycleAction(params)
                    .promise();

                console.log(
                    `Triggered lifecycle action!`,
                    JSON.stringify(result, undefined, 4)
                );

                return {
                    status: 500,
                    body: JSON.stringify(`SUCCESS`),
                };
            } catch (e) {
                console.log(`Failed to trigger lifecycle action`, e);
                return {
                    status: 500,
                    body: JSON.stringify(`FAILED`),
                };
            }
        } catch (e) {
            console.error(`Error parsing SNSEvent`, e);
            throw e;
        }
    } else {
        return {
            statusCode: 500,
            body: `Unrecognized SNSEvent object received`,
        };
    }
}

const listDocuments = async () => {
    try {
        const result = await ssm
            .listDocuments({
                DocumentFilterList: [
                    {
                        key: 'Name',
                        value: DOCUMENT_NAME!,
                    },
                ],
            })
            .promise();

        console.log(
            `Successfully listed documents`,
            JSON.stringify(result, undefined, 4)
        );

        if (result.DocumentIdentifiers?.[0].Name === DOCUMENT_NAME) {

        }

        return result;
    } catch (e) {
        console.log(
            `Failed to list specified SSM Document ${DOCUMENT_NAME}`,
            e
        );
        throw e;
    }
};
