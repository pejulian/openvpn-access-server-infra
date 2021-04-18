import {
    OpenVpnAccessServerInfraStack,
    OpenVpnAccessServerInfraStackProps,
} from '../lib/openvpn-access-server-infra-stack';
import '@aws-cdk/assert/jest';
import {
    expect as expectCDK,
    matchTemplate,
    MatchStyle,
    anything,
    arrayWith,
    objectLike,
    stringLike,
    SynthUtils,
    Capture,
    haveResourceLike,
} from '@aws-cdk/assert';
import { mocked } from 'ts-jest/utils';

import * as cdk from '@aws-cdk/core';
import * as lambda from '@aws-cdk/aws-lambda';
import * as sns from '@aws-cdk/aws-sns';
import * as s3 from '@aws-cdk/aws-s3';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as events from '@aws-cdk/aws-events';
import * as iam from '@aws-cdk/aws-iam';
import * as ssm from '@aws-cdk/aws-ssm';
import * as autoscaling from '@aws-cdk/aws-autoscaling';

jest.mock('@aws-cdk/aws-lambda', () => {
    const actualLambda: typeof lambda = jest.requireActual(
        '@aws-cdk/aws-lambda'
    );
    return {
        ...actualLambda,
    } as typeof lambda;
});

jest.mock('@aws-cdk/aws-ssm', () => {
    const actualSsm = jest.requireActual('@aws-cdk/aws-ssm');
    return {
        ...actualSsm,
        StringParameter: {
            valueFromLookup: jest
                .fn()
                .mockImplementation(
                    (scope: cdk.Stack, parameterName: string) => {
                        switch (parameterName) {
                            case 'cert-email':
                                return 'foo@bar.com';
                            case 'openvpn-hosted-zone':
                                return 'TESTZONEID123';
                            case 'openvpn-zone-name':
                                return 'foo-bar.com';
                            case 'openvpn-admin-passwd':
                                return 'adminpwd';
                            case 'openvpn-keyname':
                                return 'openvpn-keyname';
                            case 'pihole-keyname':
                                return 'pihole-keyname';
                            case 'pihole-webpassword':
                                return 'webpwd';
                            case 'openvpn-user-name':
                                return 'fooz';
                            case 'openvpn-user-passwd':
                                return 'foozpwd';
                            case 'ec2-user-data-scripts-version-tag':
                                return 'latest';
                            case 'lets-encrypt-cert-env':
                                return 'production';
                            default:
                                return 'warning: unknown key';
                        }
                    }
                ),
        },
    } as typeof ssm;
});

describe('OpenVpnAccessServerInfraStack', () => {
    const stackId = `jest-test-stack`;
    const stackProps: OpenVpnAccessServerInfraStackProps = {
        stackName: stackId,
        description: `test-description`,
        instanceType: ec2.InstanceType.of(
            ec2.InstanceClass.T3A,
            ec2.InstanceSize.MICRO
        ),
        desiredAsgCapacity: 1,
        addCapacitySchedule: events.Schedule.cron({
            minute: '0',
            hour: `8`,
            month: '*',
            weekDay: 'SAT',
            year: '*',
        }),
        removeCapacitySchedule: events.Schedule.cron({
            minute: '0',
            hour: '23',
            month: '*',
            weekDay: 'SUN',
            year: '*',
        }),
        env: {
            account: 'test-account',
            region: 'test-region',
        },
    };

    let stack: cdk.Stack;

    beforeEach(() => {
        jest.clearAllMocks();

        stack = new cdk.Stack();

        // If we used context, this is where we would set it...
        // i.e. stack.node.setContext(`${stackId}:foo`, 'bar');
    });

    it('should create a VPC with the relevant properties', () => {
        const output = new OpenVpnAccessServerInfraStack(
            stack,
            stackId,
            stackProps
        );

        expect(output).toCountResources('AWS::EC2::VPC', 1);

        expect(output).toHaveResource('AWS::EC2::VPC', {
            CidrBlock: `10.0.0.0/16`,
            EnableDnsHostnames: true,
            EnableDnsSupport: true,
        });

        expect(output).toCountResources('AWS::EC2::InternetGateway', 1);
    });

    it('should create 2 subnets with expected properties and relevant constructs linking it to the VPC that owns them', () => {
        const output = new OpenVpnAccessServerInfraStack(
            stack,
            stackId,
            stackProps
        );

        const vpcLogicalId = output.getLogicalId(
            output.vpc.node.defaultChild as ec2.CfnVPC
        );

        expect(output).toCountResources('AWS::EC2::Subnet', 2);

        expect(output).toHaveResource('AWS::EC2::Subnet', {
            CidrBlock: `10.0.0.0/24`,
            MapPublicIpOnLaunch: true,
            VpcId: {
                Ref: stringLike(vpcLogicalId),
            },
            AvailabilityZone: stringLike(`*a`),
        });

        expect(output).toHaveResource('AWS::EC2::Subnet', {
            CidrBlock: `10.0.1.0/24`,
            MapPublicIpOnLaunch: true,
            VpcId: {
                Ref: stringLike(vpcLogicalId),
            },
            AvailabilityZone: stringLike(`*b`),
        });

        expect(output).toCountResources('AWS::EC2::RouteTable', 2);

        expect(output).toCountResources(
            'AWS::EC2::SubnetRouteTableAssociation',
            2
        );

        // Two Internet Gateways for both public subnets
        expect(output).toCountResources('AWS::EC2::Route', 2);

        expect(output).toHaveResource('AWS::EC2::Route', {
            DestinationCidrBlock: '0.0.0.0/0',
        });

        expect(output).toCountResources('AWS::EC2::InternetGateway', 1);
        expect(output).toCountResources('AWS::EC2::VPCGatewayAttachment', 1);

        expect(output).toHaveResource('AWS::EC2::VPCGatewayAttachment', {
            VpcId: {
                Ref: stringLike(vpcLogicalId),
            },
        });
    });

    it('should create relevant DHCP Options to be associated to the VPC', () => {
        const output = new OpenVpnAccessServerInfraStack(
            stack,
            stackId,
            stackProps
        );

        const vpcLogicalId = output.getLogicalId(
            output.vpc.node.defaultChild as ec2.CfnVPC
        );

        expect(output).toCountResources('AWS::EC2::DHCPOptions', 1);

        expect(output).toHaveResource('AWS::EC2::DHCPOptions', {
            DomainName:
                cdk.Stack.of(output).region === 'us-east-1'
                    ? `ec2.internal`
                    : `${stackProps.env?.region}.compute.internal`,
            DomainNameServers: ['AmazonProvidedDNS'],
        });

        expect(output).toCountResources(
            'AWS::EC2::VPCDHCPOptionsAssociation',
            1
        );

        expect(output).toHaveResource('AWS::EC2::VPCDHCPOptionsAssociation', {
            VpcId: {
                Ref: stringLike(vpcLogicalId),
            },
        });
    });

    it('should create the security group that governs inbound and unbound traffic for the PiHole EC2 instance', () => {
        const output = new OpenVpnAccessServerInfraStack(
            stack,
            stackId,
            stackProps
        );

        const piHoleSecurityGroupLogicalId = output.getLogicalId(
            output.piHoleSecurityGroup.node.defaultChild as ec2.CfnSecurityGroup
        );

        const vpcLogicalId = output.getLogicalId(
            output.vpc.node.defaultChild as ec2.CfnVPC
        );

        expect(output).toCountResources('AWS::EC2::SecurityGroup', 2);

        expect(output).toHaveResource('AWS::EC2::SecurityGroup', {
            VpcId: {
                Ref: stringLike(vpcLogicalId),
            },
            SecurityGroupEgress: objectLike([
                objectLike({
                    CidrIp: '0.0.0.0/0', // assert all outbound is allowed
                }),
            ]),
            SecurityGroupIngress: objectLike([
                // assert ssh allowed
                objectLike({
                    CidrIp: '0.0.0.0/0',
                    FromPort: 22,
                    ToPort: 22,
                }),
                // assert access to pi hole web allowed
                objectLike({
                    CidrIp: '0.0.0.0/0',
                    FromPort: 80,
                    IpProtocol: 'tcp',
                    ToPort: 80,
                }),
                // assert that https is allowed
                objectLike({
                    CidrIp: '0.0.0.0/0',
                    FromPort: 443,
                    IpProtocol: 'tcp',
                    ToPort: 443,
                }),
                // assert dns traffic allowed
                objectLike({
                    CidrIp: '0.0.0.0/0',
                    IpProtocol: 'tcp',
                    FromPort: 53,
                    ToPort: 53,
                }),
                objectLike({
                    CidrIp: '0.0.0.0/0',
                    IpProtocol: 'udp',
                    FromPort: 53,
                    ToPort: 53,
                }),
                // assert unbound service traffic allowed
                objectLike({
                    CidrIp: '0.0.0.0/0',
                    IpProtocol: 'udp',
                    FromPort: 5335,
                    ToPort: 5335,
                }),
                objectLike({
                    CidrIp: '0.0.0.0/0',
                    IpProtocol: 'tcp',
                    FromPort: 5335,
                    ToPort: 5335,
                }),
                // assert dhcp traffic allowed
                objectLike({
                    CidrIp: '0.0.0.0/0',
                    IpProtocol: 'udp',
                    FromPort: 67,
                    ToPort: 67,
                }),
                objectLike({
                    CidrIp: '0.0.0.0/0',
                    IpProtocol: 'udp',
                    FromPort: 547,
                    ToPort: 547,
                }),
            ]),
        });
    });

    it('should create the security group that governs inbound and outbound traffic for OpenVPN EC2 instances', () => {
        const output = new OpenVpnAccessServerInfraStack(
            stack,
            stackId,
            stackProps
        );

        const openVpnSecurityGroupLogicalId = output.getLogicalId(
            output.openVpnSecurityGroup.node
                .defaultChild as ec2.CfnSecurityGroup
        );

        const vpcLogicalId = output.getLogicalId(
            output.vpc.node.defaultChild as ec2.CfnVPC
        );

        expect(output).toCountResources('AWS::EC2::SecurityGroup', 2);

        expect(output).toHaveResource('AWS::EC2::SecurityGroup', {
            VpcId: {
                Ref: stringLike(vpcLogicalId),
            },
            SecurityGroupEgress: objectLike([
                objectLike({
                    CidrIp: '0.0.0.0/0', // assert all outbound is allowed
                }),
            ]),
            SecurityGroupIngress: objectLike([
                // assert ssh allowed
                objectLike({
                    CidrIp: '0.0.0.0/0',
                    FromPort: 22,
                    ToPort: 22,
                }),
                // assert web interface access allowed
                objectLike({
                    CidrIp: '0.0.0.0/0',
                    IpProtocol: 'tcp',
                    FromPort: 943,
                    ToPort: 943,
                }),
                // allow https traffic
                objectLike({
                    CidrIp: '0.0.0.0/0',
                    FromPort: 443,
                    IpProtocol: 'tcp',
                    ToPort: 443,
                }),
                // allow calls to Lets Encrypt
                objectLike({
                    CidrIp: '0.0.0.0/0',
                    FromPort: 80,
                    IpProtocol: 'tcp',
                    ToPort: 80,
                }),
                // allow udp
                objectLike({
                    CidrIp: '0.0.0.0/0',
                    IpProtocol: 'udp',
                    FromPort: 1194,
                    ToPort: 1194,
                }),
            ]),
        });
    });

    it('should create an EC2 instance with relevant properties for the Pi Hole DNS server', () => {
        const output = new OpenVpnAccessServerInfraStack(
            stack,
            stackId,
            stackProps
        );

        let subnetLogicalIds: string[] = [];
        for (const subnet of output.subnets) {
            subnetLogicalIds.push(
                output.getLogicalId(subnet.node.defaultChild as ec2.CfnSubnet)
            );
        }

        const piHoleSgLogicalId = output.getLogicalId(
            output.piHoleSecurityGroup.node.defaultChild as ec2.CfnSecurityGroup
        );

        expect(output).toCountResources('AWS::EC2::Instance', 1);

        const ec2Subnet = Capture.aString();

        expect(output).toHaveResource('AWS::EC2::Instance', {
            AvailabilityZone: stringLike('*'),
            BlockDeviceMappings: [
                objectLike({
                    DeviceName: '/dev/sda1',
                    Ebs: {
                        DeleteOnTermination: true,
                        VolumeSize: 20,
                        VolumeType: 'gp2',
                    },
                }),
            ],
            InstanceType: 't3a.micro',
            SecurityGroupIds: [
                objectLike({
                    'Fn::GetAtt': [piHoleSgLogicalId, 'GroupId'],
                }),
            ],
            SourceDestCheck: false,
            SubnetId: {
                Ref: ec2Subnet.capture(),
            },
        });

        expect(subnetLogicalIds).toContain(ec2Subnet.capturedValue);
    });

    it('should create an Elastic IP for the PiHole EC2 instance', () => {
        const output = new OpenVpnAccessServerInfraStack(
            stack,
            stackId,
            stackProps
        );

        const piHoleEc2InstanceLogicalId = output.getLogicalId(
            output.piHoleInstance.node.defaultChild as ec2.CfnInstance
        );

        const elasticIpLogicalId = output.getLogicalId(output.piHoleElasticIp);

        expect(output).toCountResources('AWS::EC2::EIP', 1);

        expect(output).toHaveResource('AWS::EC2::EIP', {
            Domain: 'vpc',
            InstanceId: {
                Ref: piHoleEc2InstanceLogicalId,
            },
        });

        expect(output).toCountResources('AWS::EC2::EIPAssociation', 1);

        expect(output).toHaveResource('AWS::EC2::EIPAssociation', {
            InstanceId: {
                Ref: piHoleEc2InstanceLogicalId,
            },
            EIP: {
                Ref: elasticIpLogicalId,
            },
        });
    });

    it('should create a DNS record in the Hosted Zone that maps to the elastic IP associated to the Pi Hole EC2 instance ', () => {
        const output = new OpenVpnAccessServerInfraStack(
            stack,
            stackId,
            stackProps
        );

        expect(output).toHaveResourceLike('AWS::Route53::RecordSet', {
            Name: stringLike(`${stackProps.env?.region}.dns.foo-bar.com.`),
            Type: 'A',
            Comment: stringLike('*'),
            HostedZoneId: 'TESTZONEID123',
            ResourceRecords: [
                {
                    Ref: output.getLogicalId(output.piHoleElasticIp),
                },
            ],
            TTL: '300',
        });
    });

    it('should create a SNS Topic to publish Auto Scaling Group instance creation/destruction events for the OpenVPN fleet', () => {
        const output = new OpenVpnAccessServerInfraStack(
            stack,
            stackId,
            stackProps
        );

        expect(output).toCountResources('AWS::SNS::Topic', 2);

        expect(output).toHaveResource('AWS::SNS::Topic', {
            TopicName: `${stackId}-asg-topic-openvpn`,
        });

        // It expects that the topic has permissions to invoke the lambda
        expect(output).toHaveResourceLike('AWS::Lambda::Permission', {
            Action: 'lambda:InvokeFunction',
            FunctionName: {
                'Fn::GetAtt': [
                    output.getLogicalId(
                        output.processOpenVpnEventFn.node
                            .defaultChild as lambda.CfnFunction
                    ),
                    'Arn',
                ],
            },
            SourceArn: {
                Ref: output.getLogicalId(
                    output.openVpnAsgTopic.node.defaultChild as sns.CfnTopic
                ),
            },
        });
    });

    it('should create a SNS Topic to publish Auto Scaling Group lifecycle events for an instance termination event', () => {
        const output = new OpenVpnAccessServerInfraStack(
            stack,
            stackId,
            stackProps
        );

        expect(output).toCountResources('AWS::SNS::Topic', 2);
    });

    it('should create an S3 bucket where letsencrypt certs will be stored for reuse after initial generation', () => {
        const output = new OpenVpnAccessServerInfraStack(
            stack,
            stackId,
            stackProps
        );

        expect(output).toHaveResourceLike('AWS::S3::Bucket', {
            LifecycleConfiguration: {
                Rules: [
                    {
                        ExpirationInDays: 7,
                        Status: 'Enabled',
                    },
                ],
            },
            BucketEncryption: {
                ServerSideEncryptionConfiguration: [
                    {
                        ServerSideEncryptionByDefault: {
                            SSEAlgorithm: 'aws:kms',
                        },
                    },
                ],
            },
            PublicAccessBlockConfiguration: {
                BlockPublicAcls: true,
                BlockPublicPolicy: true,
                IgnorePublicAcls: true,
                RestrictPublicBuckets: true,
            },
        });
    });

    it('OpenVPN EC2 instances should have a S3 policy that allows it to read stored letsencrypt certificates uploaded to the S3 bucket', () => {
        const output = new OpenVpnAccessServerInfraStack(
            stack,
            stackId,
            stackProps
        );

        const openVpnCertBucketLogicalId = output.getLogicalId(
            output.openVpnCertBucket.node.defaultChild as s3.CfnBucket
        );

        expect(output).toHaveResourceLike('AWS::IAM::Policy', {
            PolicyDocument: {
                Statement: objectLike([
                    {
                        Action: [
                            's3:GetObject*',
                            's3:GetBucket*',
                            's3:List*',
                            's3:PutObject*',
                            'kms:Decrypt',
                        ],
                        Effect: 'Allow',
                        Resource: objectLike([
                            {
                                'Fn::GetAtt': [
                                    openVpnCertBucketLogicalId,
                                    'Arn',
                                ],
                            },
                            {
                                'Fn::Join': [
                                    '',
                                    [
                                        {
                                            'Fn::GetAtt': [
                                                openVpnCertBucketLogicalId,
                                                'Arn',
                                            ],
                                        },
                                        '/*',
                                    ],
                                ],
                            },
                        ]),
                    },
                ]),
            },
        });
    });

    it('should create an Auto Scaling Group that is capable of creating and tearing down OpenVPN EC2 instances as configured', () => {
        const output = new OpenVpnAccessServerInfraStack(
            stack,
            stackId,
            stackProps
        );

        expect(output).toCountResources(
            'AWS::AutoScaling::AutoScalingGroup',
            1
        );

        let subnetLogicalIds: string[] = [];
        for (const subnet of output.subnets) {
            subnetLogicalIds.push(
                output.getLogicalId(subnet.node.defaultChild as ec2.CfnSubnet)
            );
        }

        const vpcZoneIdentifier: Capture<
            Array<Record<string, string>>
        > = Capture.anyType();

        expect(output).toHaveResource('AWS::AutoScaling::AutoScalingGroup', {
            MaxSize: '1',
            MinSize: '0',
            DesiredCapacity: '1',
            VPCZoneIdentifier: vpcZoneIdentifier.capture(),
        });

        vpcZoneIdentifier.capturedValue.forEach((testValue) => {
            expect(subnetLogicalIds).toContain(testValue.Ref);
        });
    });

    it('should create an Auto Scaling Group Launch Configuration for the OpenVPN EC2 instances to be created', () => {
        const output = new OpenVpnAccessServerInfraStack(
            stack,
            stackId,
            stackProps
        );

        expect(output).toCountResources(
            'AWS::AutoScaling::LaunchConfiguration',
            1
        );

        expect(output).toHaveResourceLike(
            'AWS::AutoScaling::LaunchConfiguration',
            {
                InstanceType: 't3a.micro',
                ImageId: stringLike('ami-*'),
                UserData: anything(),
                SecurityGroups: [
                    {
                        'Fn::GetAtt': [
                            output.getLogicalId(
                                output.openVpnSecurityGroup.node
                                    .defaultChild as ec2.CfnSecurityGroup
                            ),
                            'GroupId',
                        ],
                    },
                ],
            }
        );
    });

    it('should creata a lambda function to react to EC2 instance terminating events from the OpenVPN Auto Scaling Group', () => {
        const output = new OpenVpnAccessServerInfraStack(
            stack,
            stackId,
            stackProps
        );

        expect(output).toHaveResource('AWS::Lambda::Function', {
            Code: {
                S3Bucket: {
                    Ref: stringLike(`AssetParameters*`),
                },
                S3Key: {
                    'Fn::Join': [
                        '',
                        [
                            {
                                'Fn::Select': [
                                    0,
                                    {
                                        'Fn::Split': [
                                            '||',
                                            {
                                                Ref: stringLike(
                                                    'AssetParameters*'
                                                ),
                                            },
                                        ],
                                    },
                                ],
                            },
                            {
                                'Fn::Select': [
                                    1,
                                    {
                                        'Fn::Split': [
                                            '||',
                                            {
                                                Ref: stringLike(
                                                    'AssetParameters*'
                                                ),
                                            },
                                        ],
                                    },
                                ],
                            },
                        ],
                    ],
                },
            },
            Role: {
                'Fn::GetAtt': [stringLike('*'), 'Arn'],
            },
            Environment: {
                Variables: {
                    REGION: stackProps.env?.region,
                    BUCKET_NAME: {
                        Ref: output.getLogicalId(
                            output.openVpnCertBucket.node
                                .defaultChild as s3.CfnBucket
                        ),
                    },
                    DNS_NAME: `${stackProps.env?.region}.vpn.foo-bar.com`,
                    DOCUMENT_NAME:
                        output.openVpnInstanceTerminatingSsmDocument.name,
                },
            },
            FunctionName: stringLike(`*-OpenVpnInstanceTerminatingHookFn`),
            Handler: 'instance-terminating.handler',
            MemorySize: 128,
            Runtime: 'nodejs14.x',
            Timeout: 300,
        });
    });

    it('should create a lifycycle hook for the OpenVPN Auto Scaling Group to pause and handle OpenSSL certificate backup before the EC2 instance is terminated', () => {
        const output = new OpenVpnAccessServerInfraStack(
            stack,
            stackId,
            stackProps
        );

        expect(output).toHaveResource('AWS::AutoScaling::LifecycleHook', {
            AutoScalingGroupName: {
                Ref: output.getLogicalId(
                    output.openVpnAsg.node
                        .defaultChild as autoscaling.CfnAutoScalingGroup
                ),
            },
            LifecycleTransition: 'autoscaling:EC2_INSTANCE_TERMINATING',
            DefaultResult: 'CONTINUE',
            HeartbeatTimeout: 300,
            LifecycleHookName: 'openvpn-instance-termination-lifecycle-hook',
            NotificationTargetARN: {
                Ref: stringLike('*'),
            },
            RoleARN: {
                'Fn::GetAtt': [stringLike('*'), 'Arn'],
            },
        });
    });

    it('should create a SSM Document with the relevant commands to be executed in the EC2 instance that is being terminated by the OpenVPN Auto Scaling Group', () => {
        const output = new OpenVpnAccessServerInfraStack(
            stack,
            stackId,
            stackProps
        );

        expect(output).toHaveResource('AWS::SSM::Document', {
            DocumentType: 'Command',
            Name: 'OpenVpnInstanceTerminatingDocument',
            Content: {
                schemaVersion: '2.2',
                description: stringLike('*'),
                parameters: {
                    domainName: anything(),
                    region: anything(),
                    autoScalingGroupName: anything(),
                    lifecycleHookName: anything(),
                    lifecycleActionToken: anything(),
                    bucketName: anything(),
                },
                mainSteps: [
                    {
                        action: 'aws:runShellScript',
                        name: 'runShellScript',
                        inputs: {
                            timeoutSeconds: '300',
                            runCommand: anything(),
                        },
                    },
                ],
            },
        });
    });

    it('should create a subscription where the ProcessEvent lambda listen in to Auto Scaling Group events', () => {
        const output = new OpenVpnAccessServerInfraStack(
            stack,
            stackId,
            stackProps
        );

        expect(output).toHaveResourceLike('AWS::SNS::Subscription', {
            Protocol: 'lambda',
            TopicArn: {
                Ref: output.getLogicalId(
                    output.openVpnAsgTopic.node.defaultChild as sns.CfnTopic
                ),
            },
            Endpoint: {
                'Fn::GetAtt': [
                    output.getLogicalId(
                        output.processOpenVpnEventFn.node
                            .defaultChild as lambda.CfnFunction
                    ),
                    'Arn',
                ],
            },
        });
    });

    it('should creata a policy that allows the ProcessEvent lambda function to run operations on EC2, DynamoDb and Route53', () => {
        const output = new OpenVpnAccessServerInfraStack(
            stack,
            stackId,
            stackProps
        );

        expect(output).toHaveResourceLike('AWS::IAM::Policy', {
            PolicyDocument: {
                Statement: [
                    {
                        Action: [
                            'ec2:DescribeInstances', // Describes one or more of your instances.
                            'ec2:ModifyInstanceAttribute', // Modifies the specified attribute of the specified instance.
                            // 'ec2:DescribeAddresses', // Describes one or more of your Elastic IP addresses.
                            // 'ec2:AssociateAddress', // Associates an Elastic IP address with an instance or a network interface.
                            // 'ec2:DisassociateAddress', // Allow an elastic ip address to be disassociated
                            'route53:ChangeResourceRecordSets', // Allows changes to records in a given hosted zone
                        ],
                        Effect: 'Allow',
                        Resource: '*',
                    },
                ],
            },
            Roles: [
                {
                    Ref: output.getLogicalId(
                        output.processOpenVpnEventFn.role!.node
                            .defaultChild as iam.CfnRole
                    ),
                },
            ],
        });
    });

    it('should create Lambda functions for scaling up or down the EC2 instances used for the OpenVPN access server', () => {
        const output = new OpenVpnAccessServerInfraStack(stack, stackId, {
            ...stackProps,
            addCapacitySchedule: events.Schedule.expression(
                `cron(45 23 * * ? *)`
            ),
            removeCapacitySchedule: events.Schedule.expression(
                `cron(0 18 * * ? *)`
            ),
        });

        expect(output).toHaveResource('AWS::Lambda::Function', {
            Code: {
                S3Bucket: {
                    Ref: stringLike(`AssetParameters*`),
                },
                S3Key: {
                    'Fn::Join': [
                        '',
                        [
                            {
                                'Fn::Select': [
                                    0,
                                    {
                                        'Fn::Split': [
                                            '||',
                                            {
                                                Ref: stringLike(
                                                    'AssetParameters*'
                                                ),
                                            },
                                        ],
                                    },
                                ],
                            },
                            {
                                'Fn::Select': [
                                    1,
                                    {
                                        'Fn::Split': [
                                            '||',
                                            {
                                                Ref: stringLike(
                                                    'AssetParameters*'
                                                ),
                                            },
                                        ],
                                    },
                                ],
                            },
                        ],
                    ],
                },
            },
            Role: {
                'Fn::GetAtt': [
                    output.getLogicalId(
                        output.setOpenVpnAsgToOneFn.role?.node
                            .defaultChild as iam.CfnRole
                    ),
                    'Arn',
                ],
            },
            Environment: {
                Variables: {
                    DESIRED_ASG_SIZE: '1',
                    ASG_GROUP_NAME: {
                        Ref: output.getLogicalId(
                            output.openVpnAsg.node
                                .defaultChild as autoscaling.CfnAutoScalingGroup
                        ),
                    },
                },
            },
            FunctionName: stringLike(`*-SetOpenVpnAsgToOneFn`),
            Handler: 'set-desired-asg-size.handler',
            MemorySize: 128,
            Runtime: 'nodejs14.x',
            Timeout: 10,
        });

        expect(output).toHaveResource('AWS::Lambda::Function', {
            Code: {
                S3Bucket: {
                    Ref: stringLike(`AssetParameters*`),
                },
                S3Key: {
                    'Fn::Join': [
                        '',
                        [
                            {
                                'Fn::Select': [
                                    0,
                                    {
                                        'Fn::Split': [
                                            '||',
                                            {
                                                Ref: stringLike(
                                                    'AssetParameters*'
                                                ),
                                            },
                                        ],
                                    },
                                ],
                            },
                            {
                                'Fn::Select': [
                                    1,
                                    {
                                        'Fn::Split': [
                                            '||',
                                            {
                                                Ref: stringLike(
                                                    'AssetParameters*'
                                                ),
                                            },
                                        ],
                                    },
                                ],
                            },
                        ],
                    ],
                },
            },
            Role: {
                'Fn::GetAtt': [
                    output.getLogicalId(
                        output.setOpenVpnAsgToZeroFn.role?.node
                            .defaultChild as iam.CfnRole
                    ),
                    'Arn',
                ],
            },
            Environment: {
                Variables: {
                    DESIRED_ASG_SIZE: '0',
                    ASG_GROUP_NAME: {
                        Ref: output.getLogicalId(
                            output.openVpnAsg.node
                                .defaultChild as autoscaling.CfnAutoScalingGroup
                        ),
                    },
                },
            },
            FunctionName: stringLike(`*-SetOpenVpnAsgToZeroFn`),
            Handler: 'set-desired-asg-size.handler',
            MemorySize: 128,
            Runtime: 'nodejs14.x',
            Timeout: 10,
        });
    });

    it('should create a cloudwatch rule event for scaling down based on the removeCapacity rule', () => {
        const output = new OpenVpnAccessServerInfraStack(stack, stackId, {
            ...stackProps,
            addCapacitySchedule: events.Schedule.expression(
                `cron(45 23 * * ? *)`
            ),
            removeCapacitySchedule: events.Schedule.expression(
                `cron(0 18 * * ? *)`
            ),
        });

        expect(output).toHaveResourceLike('AWS::Events::Rule', {
            ScheduleExpression: `cron(0 18 * * ? *)`,
            State: 'ENABLED',
            Targets: [
                {
                    Arn: {
                        'Fn::GetAtt': [
                            output.getLogicalId(
                                output.setOpenVpnAsgToZeroFn.node
                                    .defaultChild as lambda.CfnFunction
                            ),
                            'Arn',
                        ],
                    },
                    Id: 'Target0',
                },
            ],
        });
    });

    it('should create a cloudwatch rule event for scaling up based on the addCapacity rule', () => {
        const output = new OpenVpnAccessServerInfraStack(stack, stackId, {
            ...stackProps,
            addCapacitySchedule: events.Schedule.expression(
                `cron(45 23 * * ? *)`
            ),
            removeCapacitySchedule: events.Schedule.expression(
                `cron(0 18 * * ? *)`
            ),
        });

        expect(output).toHaveResourceLike('AWS::Events::Rule', {
            ScheduleExpression: `cron(45 23 * * ? *)`,
            State: 'ENABLED',
            Targets: [
                {
                    Arn: {
                        'Fn::GetAtt': [
                            output.getLogicalId(
                                output.setOpenVpnAsgToOneFn.node
                                    .defaultChild as lambda.CfnFunction
                            ),
                            'Arn',
                        ],
                    },
                    Id: 'Target0',
                },
            ],
        });
    });

    it('should have the expected CloudFormation output', () => {
        const output = new OpenVpnAccessServerInfraStack(
            stack,
            stackId,
            stackProps
        );

        expect(output).toHaveOutput({
            exportName: `${stackId}-PiHoleUrl`,
            outputValue: `http://${stackProps.env?.region}.dns.foo-bar.com/admin`,
        });

        expect(output).toHaveOutput({
            exportName: `${stackId}-OpenVpnUrl`,
            outputValue: `https://${stackProps.env?.region}.vpn.foo-bar.com/admin`,
        });
    });
});
