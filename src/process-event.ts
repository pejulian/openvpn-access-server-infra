/**
 * This lambda reacts to EC2 instance launch events in an auto scaling group
 * and attempts to map the public ipv4 address of that instance to the domain
 * name in the Route53 hosted zone.
 *
 * Additionally, for PiHole EC2 instances that are launched, the IP address of the
 */

import { Context, SNSEvent } from 'aws-lambda';
import { EC2, Route53 } from 'aws-sdk';

const HOSTED_ZONE = process.env['HOSTED_ZONE'];
const DNS_NAME = process.env['DNS_NAME'];
const REGION = process.env['REGION'];

const ec2Client = new EC2({
    region: REGION,
});

const r53Client = new Route53({
    region: REGION,
});

export async function handler(
    event: SNSEvent,
    context: Context
): Promise<Record<string, unknown>> {
    console.log(`Received event: ${JSON.stringify(event, undefined, 4)}`);

    const { Records } = event;
    const [Record, ...rest] = Records ?? [];
    const { Sns } = Record ?? {};
    const { Message } = Sns ?? {};

    if (typeof Message !== 'undefined') {
        try {
            const parsedMessage = JSON.parse(Message);
            console.log(
                `Received msg: ${JSON.stringify(Message, undefined, 4)}`
            );

            let instanceId: string | null = null;

            // check that the InstanceID is in the SNS notification
            if (parsedMessage.Event === 'autoscaling:EC2_INSTANCE_LAUNCH') {
                instanceId = parsedMessage.EC2InstanceId;
                console.log(`InstanceId is ${instanceId}`);
            } else {
                console.log(
                    `Ignoring event: ${JSON.stringify(
                        parsedMessage.Event,
                        undefined,
                        4
                    )}`
                );
                return {
                    statusCode: 200,
                    body: `Event ignored. Not EC2_INSTANCE_LAUNCH`,
                };
            }

            //  check that instanceId in request
            if (instanceId === null) {
                return {
                    statusCode: 200,
                    body: `Event ignored. Not EC2_INSTANCE_LAUNCH`,
                };
            }

            try {
                console.log('Calling ec2.describe_instances');

                // get thet instance state
                const describeInstancesResponse = await ec2Client
                    .describeInstances({
                        InstanceIds: [instanceId],
                    })
                    .promise();

                console.log(
                    `Response from describeInstances: ${JSON.stringify(
                        describeInstancesResponse,
                        undefined,
                        4
                    )}`
                );

                let publicIp: string | null = null;

                if (
                    typeof describeInstancesResponse?.Reservations?.[0]
                        ?.Instances?.[0]?.PublicIpAddress !== 'undefined'
                ) {
                    publicIp =
                        describeInstancesResponse.Reservations[0].Instances[0]
                            .PublicIpAddress;
                    console.log(`Successfully got IP address ${publicIp}`);
                } else {
                    return {
                        statusCode: 500,
                        body: `Did not receive the public IP address for ${instanceId}`,
                    };
                }

                try {
                    // update the instance property
                    console.log('Calling ec2.modify_instance_attribute');

                    const modifyInstanceAttributesResponse = await ec2Client
                        .modifyInstanceAttribute({
                            InstanceId: instanceId,
                            SourceDestCheck: {
                                Value: false,
                            },
                        })
                        .promise();

                    console.log(
                        `Got ec2.modify_instance_attribute response: ${JSON.stringify(
                            modifyInstanceAttributesResponse,
                            undefined,
                            4
                        )}`
                    );

                    try {
                        // update the DNS record
                        console.log(
                            'Calling route53.change_resource_record_sets'
                        );

                        const changeResourceRecordSetsResponse = await r53Client
                            .changeResourceRecordSets({
                                HostedZoneId: HOSTED_ZONE!,
                                ChangeBatch: {
                                    Comment:
                                        'Automatic DNS update based on ASG event',
                                    Changes: [
                                        {
                                            Action: 'UPSERT',
                                            ResourceRecordSet: {
                                                Name: DNS_NAME!,
                                                Type: 'A',
                                                TTL: 180,
                                                ResourceRecords: [
                                                    {
                                                        Value: publicIp,
                                                    },
                                                ],
                                            },
                                        },
                                    ],
                                },
                            })
                            .promise();

                        console.log(
                            `Got route53.change_resource_record_sets response: ${JSON.stringify(
                                changeResourceRecordSetsResponse,
                                undefined,
                                4
                            )}`
                        );

                        console.log('Successfully processed event!');

                        return {
                            statusCode: 200,
                            body: 'Successfully processed event',
                        };
                    } catch (e) {
                        console.error(
                            'Error changing Route53 resource record sets for EC2 instance',
                            e
                        );
                        throw e;
                    }
                } catch (e) {
                    console.error('Error modifying ec2 instance attributes', e);
                    throw e;
                }
            } catch (e) {
                console.error(
                    'Error describing ec2 instance and/or getting instance public ip address',
                    e
                );
                throw e;
            }
        } catch (e) {
            console.error(
                `Error parsing SNSEvent and/or extracting ASG Event data`,
                e
            );
            throw e;
        }
    } else {
        return {
            statusCode: 500,
            body: `Unrecognized SNSEvent object received`,
        };
    }
}
