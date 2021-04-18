import { AutoScaling, SSM } from 'aws-sdk';
import { Context, SNSEvent } from 'aws-lambda';

const REGION = process.env['REGION'];
const DOCUMENT_NAME = process.env['DOCUMENT_NAME'];
const DNS_NAME = process.env['DNS_NAME'];
const BUCKET_NAME = process.env['BUCKET_NAME'];

const ssm = new SSM({
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
                `Parsed ASG lifecycle event message`,
                JSON.stringify(parsedMessage, undefined, 4)
            );

            // run cleanup action
            const documentIdentifier = await listDocuments();

            if (typeof documentIdentifier !== 'undefined') {
                await sendCommand(
                    documentIdentifier,
                    parsedMessage.EC2InstanceId,
                    parsedMessage.AutoScalingGroupName,
                    parsedMessage.LifecycleHookName,
                    parsedMessage.LifecycleActionToken
                );
            }

            return {
                status: 200,
                body: JSON.stringify(`SUCCESS`),
            };
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

const listDocuments = async (): Promise<SSM.DocumentIdentifier | undefined> => {
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

        const match = result.DocumentIdentifiers?.find((documentIdentifier) => {
            if (documentIdentifier.Name === DOCUMENT_NAME) {
                return true;
            }
            return false;
        });

        if (typeof match === 'undefined') {
            console.log(`No document with name ${DOCUMENT_NAME} found`);
        }

        return match;
    } catch (e) {
        console.log(
            `Failed to list specified SSM Document ${DOCUMENT_NAME}`,
            e
        );
        return undefined;
    }
};

/**
 * Execute the contents of the specified document as a command to the EC2 instance
 * @param document The document to execute
 * @param instanceId The EC2 instance to run the command on
 */
const sendCommand = async (
    document: SSM.DocumentIdentifier,
    instanceId: string,
    autoScalingGroupName: string,
    lifecycleHookName: string,
    lifecycleActionToken: string
): Promise<string | undefined> => {
    try {
        if (typeof document.Name === 'undefined') {
            console.log(
                `Unnamed document cannot be run!`,
                JSON.stringify(document, undefined, 4)
            );
            return;
        }

        console.log(
            `Sending command via document name ${document.Name} to EC2 instance ${instanceId}`
        );

        const response = await ssm
            .sendCommand({
                DocumentName: document.Name,
                InstanceIds: [instanceId],
                TimeoutSeconds: 300,
                Parameters: {
                    region: [REGION!],
                    domainName: [DNS_NAME!],
                    bucketName: [BUCKET_NAME!],
                    autoScalingGroupName: [autoScalingGroupName],
                    lifecycleHookName: [lifecycleHookName],
                    lifecycleActionToken: [lifecycleActionToken],
                },
            })
            .promise();

        console.log(
            `Command response is`,
            JSON.stringify(response, undefined, 4)
        );

        return response.Command?.CommandId;
    } catch (e) {
        console.log(`An error occured while sending command`, e);
        return undefined;
    }
};
