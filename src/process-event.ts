/**
 * This lambda reacts to EC2 instance launch events in an auto scaling group
 * and attempts to map the public ipv4 address of that instance to the domain
 * name in the Route53 hosted zone.
 *
 * Additionally, for PiHole EC2 instances that are launched, the IP address of the
 */

import { Context, SNSEvent } from 'aws-lambda';
import { AWSError, EC2, Route53 } from 'aws-sdk';
import { PromiseResult } from 'aws-sdk/lib/request';

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
    _context: Context
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

            let instanceId: string;

            // check that the InstanceID is in the SNS notification
            if (parsedMessage.Event === 'autoscaling:EC2_INSTANCE_LAUNCH') {
                instanceId = parsedMessage.EC2InstanceId;
                console.log(
                    `InstanceId that is being launched is: ${instanceId}`
                );
                return await instanceLaunchActions(instanceId);
            } else {
                // We don't have to worry about instance termination management as the 
                // elastic ip will be automatically disassociated from the ec2 instance
                // https://docs.amazonaws.cn/en_us/AWSEC2/latest/UserGuide/ec2-instance-lifecycle.html
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

const instanceLaunchActions = async (
    instanceId: string
): Promise<Record<string, unknown>> => {
    try {
        console.log('Calling ec2.describe_instances');

        const describeInstancesResponse = await describeEc2Instances(instanceId);

        // const publicIp = await associateElasticIpAddress(instanceId);

        let publicIp: string | null = null;
        if (
            typeof describeInstancesResponse?.Reservations?.[0]
                ?.Instances?.[0]?.PublicIpAddress !== 'undefined'
        ) {
            publicIp =
                describeInstancesResponse.Reservations[0].Instances[0]
                    .PublicIpAddress;
            console.log(`Successfully got public IP address ${publicIp} for EC2 instance ${instanceId}`);
        } else {
            return {
                statusCode: 500,
                body: `Could not retrieve the public IP address for EC2 instance ${instanceId}`,
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
                console.log('Calling route53.change_resource_record_sets');

                const changeResourceRecordSetsResponse = await r53Client
                    .changeResourceRecordSets({
                        HostedZoneId: HOSTED_ZONE!,
                        ChangeBatch: {
                            Comment: 'Automatic DNS update based on ASG event',
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
};

// /**
//  * Associates an elastic ip address to an EC2 instance
//  * @param instanceId The EC2 instance to associate the elastic IP address to
//  * @returns
//  */
// const associateElasticIpAddress = async (
//     instanceId: string
// ): Promise<string> => {
//     try {
//         // Fetch the elastic ip to be used by this ec2 instance
//         const describedEipAddresses = await describeEipAddresses();
//         const eipAddress = describedEipAddresses.Addresses?.[0];

//         if (typeof eipAddress === 'undefined') {
//             throw new Error(`Elastic IP address is undefined!`);
//         }

//         try {
//             const response = await ec2Client
//                 .associateAddress({
//                     AllocationId: eipAddress.AllocationId,
//                     InstanceId: instanceId,
//                 })
//                 .promise();

//             console.log(
//                 `Elastic Ip with allocation id ${eipAddress.AllocationId} has been associated to EC2 instance with id ${instanceId}`,
//                 response.AssociationId
//             );

//             if (
//                 typeof eipAddress.PublicIp === 'undefined' ||
//                 typeof eipAddress.AllocationId === 'undefined'
//             ) {
//                 throw new Error(`Elastic IP has no Public IP or Allocation Id`);
//             }

//             if (typeof response.AssociationId === 'undefined') {
//                 throw new Error(
//                     `No association id found after associating Elastic Ip to EC2 instance`
//                 );
//             }

//             return eipAddress.PublicIp;
//         } catch (e) {
//             console.error(
//                 `Error allocating EIP with AllocationId ${eipAddress.AllocationId} to EC2 instance with ID ${instanceId}`,
//                 e
//             );
//             throw e;
//         }
//     } catch (e) {
//         console.error(
//             `Error retrieving Elastic IP address with allocation id ${EIP_ALLOCATION_ID}`,
//             e
//         );
//         throw e;
//     }
// };

// /**
//  * Describes an elastic IP address
//  * @returns The described Elastic IP address
//  */
// const describeEipAddresses = async (): Promise<
//     PromiseResult<EC2.DescribeAddressesResult, AWSError>
// > => {
//     try {
//         // Fetch the elastic ip to be used by this ec2 instance
//         const describedEipAddresses = await ec2Client
//             .describeAddresses({
//                 Filters: [
//                     {
//                         Name: 'domain',
//                         Values: ['vpc'],
//                     },
//                 ],
//                 AllocationIds: [EIP_ALLOCATION_ID!],
//             })
//             .promise();

//         console.log(
//             `Described EIP Addresses`,
//             JSON.stringify(describedEipAddresses, undefined, 4)
//         );

//         return describedEipAddresses;
//     } catch (e) {
//         console.error(
//             `Error retrieving Elastic IP address with allocation id ${EIP_ALLOCATION_ID}`,
//             e
//         );
//         throw e;
//     }
// };

/**
 * Describe an EC2 instance
 * @param instanceId The EC2 instance to be described
 */
const describeEc2Instances = async (instanceId: string): Promise<PromiseResult<EC2.DescribeInstancesResult, AWSError>> => {
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
    return describeInstancesResponse;
};

