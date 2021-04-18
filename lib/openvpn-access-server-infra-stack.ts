/**
 * Inspired by https://github.com/mattmcclean/openvpn-cdk-demo/blob/master/lib/private-client-vpn-stack.ts
 */
import * as path from 'path';
import * as packageJson from '../package.json';

import * as cdk from '@aws-cdk/core';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as sns from '@aws-cdk/aws-sns';
import * as autoscaling from '@aws-cdk/aws-autoscaling';
import * as hooktargets from '@aws-cdk/aws-autoscaling-hooktargets';
import * as ssm from '@aws-cdk/aws-ssm';
import * as lambda from '@aws-cdk/aws-lambda';
import * as iam from '@aws-cdk/aws-iam';
import * as logs from '@aws-cdk/aws-logs';
import * as route53 from '@aws-cdk/aws-route53';
import * as s3 from '@aws-cdk/aws-s3';

import { Rule, Schedule } from '@aws-cdk/aws-events';
import { LambdaFunction } from '@aws-cdk/aws-events-targets';
import { SnsEventSource } from '@aws-cdk/aws-lambda-event-sources';
import { Stack, Tags } from '@aws-cdk/core';
import { HostedZone } from '@aws-cdk/aws-route53';

export interface ConfigurationParameters {
    readonly certEmail: string;
    readonly hostedZone: string;
    readonly zoneName: string;
    readonly adminPassword: string;
    readonly openVpnKeyName: string;
    readonly piHoleKeyName: string;
    readonly piHoleWebPassword: string;
    readonly vpnUsername: string;
    readonly vpnPassword: string;
    readonly userDataScriptsVersionTag: string;
    readonly letsEncryptCertEnv: string;
}

export interface OpenVpnAccessServerInfraStackProps extends cdk.StackProps {
    readonly instanceType?: ec2.InstanceType;
    readonly desiredAsgCapacity?: number;
    readonly addCapacitySchedule?: Schedule;
    readonly removeCapacitySchedule?: Schedule;
}

export class OpenVpnAccessServerInfraStack extends cdk.Stack {
    public readonly vpc: ec2.Vpc;
    public readonly subnets: ec2.ISubnet[];

    public readonly openVpnCertBucket: s3.Bucket;
    public readonly openVpnSecurityGroup: ec2.SecurityGroup;
    public readonly openVpnImage: ec2.GenericLinuxImage;
    public readonly openVpnAsg: autoscaling.AutoScalingGroup;
    public readonly openVpnInstanceTerminatingLifecycleHook: autoscaling.LifecycleHook;
    public readonly openVpnInstanceTerminatingFunctionHook: hooktargets.FunctionHook;
    public readonly openVpnInstanceTerminatingFunction: lambda.Function;
    public readonly openVpnInstanceTerminatingSsmDocument: ssm.CfnDocument;
    public readonly openVpnAsgTopic: sns.Topic;
    public readonly processOpenVpnEventFn: lambda.Function;
    public readonly setOpenVpnAsgToZeroFn: lambda.Function;
    public readonly setOpenVpnAsgToOneFn: lambda.Function;
    public readonly openVpnUrlCfnOutput: cdk.CfnOutput;

    public readonly piHoleSecurityGroup: ec2.SecurityGroup;
    public readonly piHoleImage: ec2.IMachineImage;
    public readonly piHoleInstance: ec2.Instance;
    public readonly piHoleElasticIp: ec2.CfnEIP;
    public readonly piHoleEipAssociation: ec2.CfnEIPAssociation;
    public readonly piHoleUrlCfnOutput: cdk.CfnOutput;

    public readonly scaleUpRule: Rule;
    public readonly scaleDownRule: Rule;

    public static NVM_INSTALL_COMMANDS = [
        `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.38.0/install.sh | bash`,
        `export NVM_DIR="$HOME/.nvm"`,
        `[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"`,
        `nvm install 14`,
        `node -e "console.log('Running Node.js ' + process.version)"`,
    ];

    constructor(
        scope: cdk.Construct,
        id: string,
        props?: OpenVpnAccessServerInfraStackProps
    ) {
        super(scope, id, props);

        this.setupTags(id, props?.env?.region!, props?.env?.account!);

        const {
            certEmail,
            hostedZone,
            zoneName,
            adminPassword,
            openVpnKeyName,
            piHoleKeyName,
            piHoleWebPassword,
            vpnUsername,
            vpnPassword,
            userDataScriptsVersionTag,
            letsEncryptCertEnv,
        } = this.getParametersFromStore();

        const region = cdk.Stack.of(this).region;
        const resolvedHostedZone = HostedZone.fromHostedZoneId(
            this,
            `${id}-resolved-hostedzone`,
            hostedZone
        );

        // Create a new VPC with 2 public subnets in up to 2 AZs
        // All private subnets will automatically have a NAT gateway assigned to its Route Table
        // All public subnets will automatically have an Internet Gateway assigned to its Route Table
        this.vpc = new ec2.Vpc(this, `${id}-vpc`, {
            cidr: '10.0.0.0/16',
            maxAzs: 2,
            enableDnsHostnames: true,
            enableDnsSupport: true,
            subnetConfiguration: [
                {
                    name: `${id}-ingress`,
                    subnetType: ec2.SubnetType.PUBLIC,
                    cidrMask: 24,
                },
            ],
        });

        this.subnets = this.vpc.publicSubnets;

        // https://docs.aws.amazon.com/vpc/latest/userguide/VPC_DHCP_Options.html
        const dhcpOptions = new ec2.CfnDHCPOptions(this, `${id}-dhcp-options`, {
            domainName:
                region === 'us-east-1'
                    ? `ec2.internal`
                    : `${region}.compute.internal`,
            domainNameServers: [`AmazonProvidedDNS`],
        });

        new ec2.CfnVPCDHCPOptionsAssociation(
            this,
            `${id}-dhcp-options-association`,
            {
                dhcpOptionsId: dhcpOptions.ref, // For a L1 construct, the reference is obtained using the "ref" property
                vpcId: this.vpc.vpcId, // for L2 constructs, there usually is an "*Id" field that can be used to reference the construct
            }
        );

        // When the stack is deleted, destroy the VPC
        this.vpc.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        //================================================================================
        // Pi Hole setup
        //================================================================================

        this.piHoleSecurityGroup = new ec2.SecurityGroup(
            this,
            `${id}-sg-pihole`,
            {
                description: `The security group that governs inbound and outbound traffic rules for the PiHole instance running in the ${id}-vpc`,
                vpc: this.vpc,
                allowAllOutbound: true,
            }
        );

        this.piHoleSecurityGroup.addIngressRule(
            ec2.Peer.anyIpv4(),
            ec2.Port.tcp(22),
            `Allow SSH access to the PiHole EC2 instance`
        );

        this.piHoleSecurityGroup.addIngressRule(
            ec2.Peer.anyIpv4(),
            ec2.Port.tcp(80),
            `Allow access to the PiHole web interface (lighttpd)`
        );

        this.piHoleSecurityGroup.addIngressRule(
            ec2.Peer.anyIpv4(),
            ec2.Port.tcp(443),
            `Allow HTTPS (for cURL, npm)`
        );

        this.piHoleSecurityGroup.addIngressRule(
            ec2.Peer.anyIpv4(),
            ec2.Port.tcp(53),
            `Allow any incoming TCP DNS traffic`
        );

        this.piHoleSecurityGroup.addIngressRule(
            ec2.Peer.anyIpv4(),
            ec2.Port.udp(53),
            `Allow any incoming UDP DNS traffic`
        );

        this.piHoleSecurityGroup.addIngressRule(
            ec2.Peer.anyIpv4(),
            ec2.Port.udp(5335),
            `For unbound recursive dns service`
        );

        this.piHoleSecurityGroup.addIngressRule(
            ec2.Peer.anyIpv4(),
            ec2.Port.tcp(5335),
            `For unbound recursive dns service`
        );

        this.piHoleSecurityGroup.addIngressRule(
            ec2.Peer.anyIpv4(),
            ec2.Port.udp(67),
            `Allow any incoming DHCP traffic`
        );

        this.piHoleSecurityGroup.addIngressRule(
            ec2.Peer.anyIpv4(),
            ec2.Port.udp(547),
            `Allow any incoming DHCP traffic on IPv6`
        );

        // When the stack is deleted, destroy the Security Group
        this.piHoleSecurityGroup.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Instance Role and SSM Managed Policy
        const role = new iam.Role(this, 'InstanceSSM', {
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
        });

        role.addManagedPolicy(
            iam.ManagedPolicy.fromAwsManagedPolicyName(
                'service-role/AmazonEC2RoleforSSM'
            )
        );

        this.piHoleImage = ec2.MachineImage.genericLinux({
            'us-east-1': 'ami-013f17f36f8b1fefb',
            'eu-west-1': 'ami-0121ef35996ede438',
            'eu-west-2': 'ami-02701bcdc5509e57b',
            'ap-south-1': 'ami-0b84c6433cdbe5c3e',
            'ap-southeast-1': 'ami-05b891753d41ff88f',
            'eu-central-1': 'ami-0e0102e3ff768559b',
        });

        // create an EC2 instance for the PI hole server
        this.piHoleInstance = new ec2.Instance(this, `${id}-ec2-pihole`, {
            instanceName: `${id}-ec2-pihole`,
            vpc: this.vpc,
            instanceType: props?.instanceType
                ? props.instanceType
                : ec2.InstanceType.of(
                      ec2.InstanceClass.T3A,
                      ec2.InstanceSize.MICRO
                  ),
            machineImage: this.piHoleImage,
            role,
            keyName: piHoleKeyName,
            vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
            sourceDestCheck: false,
            securityGroup: this.piHoleSecurityGroup, // Add security group to govern the instance
            blockDevices: [
                {
                    // deviceName: The deviceName depends on the image type being used, get the correct deviceName by attempting to create an instance in console
                    deviceName: `/dev/sda1`, // for Ubuntu Server 18.04 LTS
                    volume: ec2.BlockDeviceVolume.ebs(20, {
                        volumeType: ec2.EbsDeviceVolumeType.GENERAL_PURPOSE_SSD,
                        deleteOnTermination: true,
                    }),
                },
            ],
        });

        // The order that these scripts are added are important!
        // https://dev.to/denolfe/easily-rerun-ec2-userdata-3k18
        // https://stackoverflow.com/questions/54415841/nodejs-not-installed-successfully-in-aws-ec2-inside-user-data
        this.piHoleInstance.userData.addCommands(
            `git config --global http.postBuffer 1048576000`,
            ...OpenVpnAccessServerInfraStack.NVM_INSTALL_COMMANDS,
            `npx openvpn-access-server-scripts@${userDataScriptsVersionTag} setup-pihole -p \"'${piHoleWebPassword}'\" -r "${region}"`
        );

        this.piHoleInstance.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // create an elastic ip
        this.piHoleElasticIp = new ec2.CfnEIP(this, `${id}-eip-pihole`, {
            domain: 'vpc', // https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-ec2-eip.html#cfn-ec2-eip-domain
            instanceId: this.piHoleInstance.instanceId,
        });
        this.piHoleElasticIp.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Associate the PiHole EC2 Instance to the Elastic IP
        this.piHoleEipAssociation = new ec2.CfnEIPAssociation(
            this,
            `${id}-eip-assoc-pihole`,
            {
                eip: this.piHoleElasticIp.ref,
                instanceId: this.piHoleInstance.instanceId,
            }
        );
        this.piHoleEipAssociation.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Associate the Elastic IP to the domain by mapping it as a A record in the hosted zone
        new route53.ARecord(this, `${id}-a-record-pihole`, {
            zone: route53.HostedZone.fromHostedZoneAttributes(
                this,
                `${id}-hostedzone-attrs`,
                {
                    hostedZoneId: hostedZone,
                    zoneName,
                }
            ),
            target: route53.RecordTarget.fromIpAddresses(
                this.piHoleElasticIp.ref
            ),
            ttl: cdk.Duration.seconds(300),
            recordName: `${region}.dns.${zoneName}`,
            comment: `A DNS record that creates a mapping from the Elastic IP associated to the PiHole EC2 instance to the domain`,
        });

        // output an FQDN to Pi Hole instance
        this.piHoleUrlCfnOutput = new cdk.CfnOutput(this, 'PiHoleUrl', {
            value: `http://${region}.dns.${zoneName}/admin`,
            description: `The PiHole web interface URL for administrators`,
            exportName: `${id}-PiHoleUrl`,
        });

        //================================================================================
        // OpenVPN Setup
        //================================================================================

        // Create a security group for the VPC
        this.openVpnSecurityGroup = new ec2.SecurityGroup(
            this,
            `${id}-sg-openvpn`,
            {
                description: `The security group that governs inbound and outbound traffic rules for OpenVPN instances running within the ${id}-vpc`,
                vpc: this.vpc,
                allowAllOutbound: true,
            }
        );

        this.openVpnSecurityGroup.addIngressRule(
            ec2.Peer.anyIpv4(),
            ec2.Port.tcp(22),
            `Allow SSH access to EC2 instances`
        );

        this.openVpnSecurityGroup.addIngressRule(
            ec2.Peer.anyIpv4(),
            ec2.Port.tcp(943),
            `Allows access to the web interface of the OpenVPN Access Server`
        );

        this.openVpnSecurityGroup.addIngressRule(
            ec2.Peer.anyIpv4(),
            ec2.Port.tcp(443),
            `Allow HTTPS`
        );

        this.openVpnSecurityGroup.addIngressRule(
            ec2.Peer.anyIpv4(),
            ec2.Port.tcp(80),
            `Allow HTTP access for Lets Encrypt challenge`
        );

        this.openVpnSecurityGroup.addIngressRule(
            ec2.Peer.anyIpv4(),
            ec2.Port.udp(1194),
            `Default OpenVPN UDP Daemon Port`
        );

        // When the stack is deleted, destroy the Security Group
        this.openVpnSecurityGroup.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

        // Create an S3 bucket to hold Lets Encrypt certs so that they can
        // be reused in subsequent OpenVPN EC2 instances created by the ASG
        // after the initial one that first created the cert is destroyed
        this.openVpnCertBucket = new s3.Bucket(this, `${id}-openvpn-certs`, {
            autoDeleteObjects: true,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            encryption: s3.BucketEncryption.KMS_MANAGED,
            lifecycleRules: [
                {
                    enabled: true,
                    expiration: cdk.Duration.days(7),
                },
            ],
        });

        this.openVpnImage = new ec2.GenericLinuxImage({
            'us-east-1': 'ami-0acd966a5ea6b1b5f',
            'eu-west-1': 'ami-073378a1210b802e8',
            'eu-west-2': 'ami-04f6f64e951610775',
            'ap-south-1': 'ami-07ec40bd7c315379b',
            'ap-southeast-1': 'ami-0a8fdce33ca9cbe51',
            'eu-central-1': 'ami-03dbe587c22d7aa42',
        });

        let openVpnUserData: ec2.UserData = ec2.UserData.forLinux({
            shebang: '#!/bin/bash',
        });

        // The order that these scripts are added are important!
        // https://dev.to/denolfe/easily-rerun-ec2-userdata-3k18
        // https://stackoverflow.com/questions/54415841/nodejs-not-installed-successfully-in-aws-ec2-inside-user-data
        openVpnUserData.addCommands(
            ...OpenVpnAccessServerInfraStack.NVM_INSTALL_COMMANDS,
            `echo "openvpn:${this.escapeRegExp(adminPassword)}" | chpasswd`,
            `npx openvpn-access-server-scripts@${userDataScriptsVersionTag} setup-openvpn -d "${region}.vpn.${zoneName}" -e "${certEmail}" -b "${this.openVpnCertBucket.bucketName}" -r "${region}" -h "${region}.vpn.${zoneName}" -i "${this.piHoleInstance.instancePrivateIp}" -u "${vpnUsername}" -p "\'${vpnPassword}'\" -c "${letsEncryptCertEnv}"`
        );

        this.openVpnAsgTopic = new sns.Topic(this, `${id}-asg-topic-openvpn`, {
            topicName: `${id}-asg-topic-openvpn`,
            displayName:
                'SNS topic for OpenVPN Auto Scaling Group notifications',
        });

        // create the autoscaling group
        this.openVpnAsg = new autoscaling.AutoScalingGroup(
            this,
            `${id}-asg-openvpn`,
            {
                autoScalingGroupName: `${id}-asg-openvpn`,
                vpc: this.vpc,
                instanceType: props?.instanceType
                    ? props.instanceType
                    : ec2.InstanceType.of(
                          ec2.InstanceClass.T3A,
                          ec2.InstanceSize.MICRO
                      ),
                machineImage: this.openVpnImage,
                keyName: openVpnKeyName,
                maxCapacity: 1, // You shouldn't change this becuase changing it to other values is contrary to the objective of this ASG
                minCapacity: 0, // You shouldn't change this becuase changing it to other values is contrary to the objective of this ASG
                desiredCapacity: props?.desiredAsgCapacity
                    ? props.desiredAsgCapacity
                    : 1, // You shouldn't change this becuase changing it to other values is contrary to the objective of this ASG
                vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
                userData: openVpnUserData,
                notificationsTopic: this.openVpnAsgTopic,
                securityGroup: this.openVpnSecurityGroup, // Add security group to govern instances created by ASG
            }
        );

        //==========================================================================================================
        // ASG Lifecycle Hooks
        //==========================================================================================================

        this.openVpnInstanceTerminatingSsmDocument = new ssm.CfnDocument(
            this,
            `${id}-openvpn-instance-terminating-ssm-document`,
            {
                documentType: 'Command',
                name: `OpenVpnInstanceTerminatingDocument`,
                content: {
                    schemaVersion: '2.2',
                    description: 'Backup latest SSL certificate',
                    parameters: {
                        domainName: {
                            type: 'String',
                            description: `The domain name to use to register the SSL certificate`,
                        },
                        region: {
                            type: 'String',
                            description: `The AWS region to use when using the SDK to communicate with AWS`,
                        },
                        autoScalingGroupName: {
                            type: 'String',
                            description:
                                'The name of the auto scaling group where lifecycle operations are being triggered',
                        },
                        lifecycleHookName: {
                            type: 'String',
                            description: `The lifecycle hook name`,
                        },
                        lifecycleActionToken: {
                            type: 'String',
                            description: `The lifecycle token (needed for completing the hook)`,
                        },
                        bucketName: {
                            type: 'String',
                            description: `The S3 bucket where SSL certificates will be backed up to`,
                        },
                    },
                    mainSteps: [
                        {
                            action: 'aws:runShellScript',
                            name: 'runShellScript',
                            inputs: {
                                timeoutSeconds: `${cdk.Duration.minutes(
                                    5
                                ).toSeconds()}`,
                                runCommand: [
                                    ...OpenVpnAccessServerInfraStack.NVM_INSTALL_COMMANDS,
                                    `npx openvpn-access-server-scripts@${userDataScriptsVersionTag} backup-ssl-cert -d "{{ domainName }}" -r "{{ region }}" -b "{{ bucketName }}" -a "{{ autoScalingGroupName }}" -l "{{ lifecycleHookName }}" -t "{{ lifecycleActionToken }}"`,
                                ],
                            },
                        },
                    ],
                },
                tags: Object.entries(Stack.of(this).tags.tagValues()).map(
                    ([key, value]) =>
                        ({
                            key,
                            value,
                        } as cdk.CfnTag)
                ),
            }
        );

        // allow System Manager Agent to make API calls to system manager
        this.openVpnAsg.role.addManagedPolicy(
            iam.ManagedPolicy.fromAwsManagedPolicyName(
                'AmazonSSMManagedInstanceCore'
            )
        );

        // Ensure that all ec2 instances can read from the bucket containing the certs
        this.openVpnAsg.addToRolePolicy(
            new iam.PolicyStatement({
                actions: [
                    's3:GetObject*',
                    's3:GetBucket*',
                    's3:List*',
                    's3:PutObject*',
                    'kms:Decrypt',
                ],
                resources: [
                    `${this.openVpnCertBucket.bucketArn}`,
                    `${this.openVpnCertBucket.bucketArn}/*`,
                ],
                effect: iam.Effect.ALLOW,
            })
        );

        // add policy so that ec2 instances can call lifecycle actions for auto scaling group
        this.openVpnAsg.role.addToPrincipalPolicy(
            new iam.PolicyStatement({
                resources: ['*'],
                effect: iam.Effect.ALLOW,
                actions: ['autoscaling:CompleteLifecycleAction'],
            })
        );

        this.openVpnInstanceTerminatingFunction = new lambda.Function(
            this,
            `${id}-openvpn-instance-terminating-hook-fn`,
            {
                runtime: lambda.Runtime.NODEJS_14_X,
                memorySize: 128,
                functionName: `${id}-OpenVpnInstanceTerminatingHookFn`,
                description: `Lambda function that is triggered by the Auto Scaling Group lifecycle event when an EC2 instance is shutting down`,
                code: lambda.Code.fromAsset(path.join(__dirname, '../dist')),
                handler: 'instance-terminating.handler',
                timeout: cdk.Duration.minutes(5),
                logRetention: logs.RetentionDays.ONE_DAY,
                environment: {
                    REGION: region,
                    BUCKET_NAME: this.openVpnCertBucket.bucketName,
                    DNS_NAME: `${region}.vpn.${zoneName}`,
                    DOCUMENT_NAME:
                        this.openVpnInstanceTerminatingSsmDocument.name ?? '',
                },
            }
        );

        if (this.openVpnInstanceTerminatingFunction.role) {
            // add policy so that lambda can interact with ssm
            this.openVpnInstanceTerminatingFunction.role.addToPrincipalPolicy(
                new iam.PolicyStatement({
                    resources: ['*'],
                    effect: iam.Effect.ALLOW,
                    actions: ['ssm:*'],
                })
            );

            // allow the run command to create logs
            this.openVpnInstanceTerminatingFunction.role.addToPrincipalPolicy(
                new iam.PolicyStatement({
                    resources: ['*'],
                    effect: iam.Effect.ALLOW,
                    actions: [
                        'logs:CreateLogGroup',
                        'logs:CreateLogStream',
                        'logs:DescribeLogGroups',
                        'logs:DescribeLogStreams',
                        'logs:PutLogEvents',
                    ],
                })
            );
        }

        this.openVpnInstanceTerminatingFunctionHook = new hooktargets.FunctionHook(
            this.openVpnInstanceTerminatingFunction
        );

        this.openVpnInstanceTerminatingLifecycleHook = new autoscaling.LifecycleHook(
            this,
            `${id}-asg-openvpn-lifecycle-hook`,
            {
                autoScalingGroup: this.openVpnAsg,
                lifecycleTransition:
                    autoscaling.LifecycleTransition.INSTANCE_TERMINATING,
                lifecycleHookName: `openvpn-instance-termination-lifecycle-hook`,
                defaultResult: autoscaling.DefaultResult.CONTINUE,
                heartbeatTimeout: cdk.Duration.minutes(5),
                notificationTarget: this.openVpnInstanceTerminatingFunctionHook,
            }
        );

        //==========================================================================================================

        // create the lambda function to describe instances
        this.processOpenVpnEventFn = new lambda.Function(
            this,
            `${id}-ProcessOpenVpnEventFn`,
            {
                functionName: `${id}-ProcessOpenVpnEventFn`,
                description: `Lambda to create a record set in Route53 for the public IP of a newly created EC2 instance to the specified FQDN`,
                code: lambda.Code.fromAsset(path.join(__dirname, '../dist')),
                handler: 'process-event.handler',
                timeout: cdk.Duration.seconds(30),
                runtime: lambda.Runtime.NODEJS_14_X,
                memorySize: 128,
                logRetention: logs.RetentionDays.ONE_DAY,
                environment: {
                    HOSTED_ZONE: hostedZone,
                    DNS_NAME: `${region}.vpn.${zoneName}`,
                    REGION: region,
                },
            }
        );

        // add policy so that lambda can interact with ec2 and route53
        if (this.processOpenVpnEventFn.role) {
            this.processOpenVpnEventFn.role.addToPrincipalPolicy(
                new iam.PolicyStatement({
                    resources: ['*'],
                    effect: iam.Effect.ALLOW,
                    actions: [
                        'ec2:DescribeInstances', // Describes one or more of your instances.
                        'ec2:ModifyInstanceAttribute', // Modifies the specified attribute of the specified instance.
                        'route53:ChangeResourceRecordSets', // Allows changes to records in a given hosted zone
                    ],
                })
            );
        }

        this.processOpenVpnEventFn.applyRemovalPolicy(
            cdk.RemovalPolicy.DESTROY
        );

        this.processOpenVpnEventFn.addEventSource(
            new SnsEventSource(this.openVpnAsgTopic)
        );

        if (props?.addCapacitySchedule && props?.removeCapacitySchedule) {
            // create the lambda function to set ASG to 0
            this.setOpenVpnAsgToZeroFn = new lambda.Function(
                this,
                `${id}-SetOpenVpnAsgToZeroFn`,
                {
                    functionName: `${id}-SetOpenVpnAsgToZeroFn`,
                    description: `Lambda function that sets the ASG desired capacity to 0 (triggers a scale in process)`,
                    code: lambda.Code.fromAsset(
                        path.join(__dirname, '../dist')
                    ),
                    handler: 'set-desired-asg-size.handler',
                    timeout: cdk.Duration.seconds(10),
                    memorySize: 128,
                    logRetention: logs.RetentionDays.ONE_DAY,
                    runtime: lambda.Runtime.NODEJS_14_X,
                    environment: {
                        DESIRED_ASG_SIZE: '0',
                        ASG_GROUP_NAME: this.openVpnAsg.autoScalingGroupName,
                    },
                }
            );

            this.setOpenVpnAsgToZeroFn.addToRolePolicy(
                new iam.PolicyStatement({
                    resources: [this.openVpnAsg.autoScalingGroupArn],
                    actions: ['autoscaling:UpdateAutoScalingGroup'],
                })
            );

            this.setOpenVpnAsgToZeroFn.applyRemovalPolicy(
                cdk.RemovalPolicy.DESTROY
            );

            // create the lambda function to set ASG to 1
            this.setOpenVpnAsgToOneFn = new lambda.Function(
                this,
                `${id}-SetOpenVpnAsgToOneFn`,
                {
                    functionName: `${id}-SetOpenVpnAsgToOneFn`,
                    description: `Lambda function that sets the ASG desired capacity to 1 (triggers a scale out process)`,
                    code: lambda.Code.fromAsset(
                        path.join(__dirname, '../dist')
                    ),
                    handler: 'set-desired-asg-size.handler',
                    timeout: cdk.Duration.seconds(10),
                    runtime: lambda.Runtime.NODEJS_14_X,
                    memorySize: 128,
                    logRetention: logs.RetentionDays.ONE_DAY,
                    environment: {
                        DESIRED_ASG_SIZE: '1',
                        ASG_GROUP_NAME: this.openVpnAsg.autoScalingGroupName,
                    },
                }
            );

            this.setOpenVpnAsgToOneFn.addToRolePolicy(
                new iam.PolicyStatement({
                    resources: [this.openVpnAsg.autoScalingGroupArn],
                    actions: ['autoscaling:UpdateAutoScalingGroup'],
                })
            );

            this.setOpenVpnAsgToOneFn.applyRemovalPolicy(
                cdk.RemovalPolicy.DESTROY
            );

            // add scheduled rule to scale up
            this.scaleUpRule = new Rule(this, `${id}-AddCapacityRule`, {
                enabled: true,
                schedule: props.addCapacitySchedule,
                targets: [new LambdaFunction(this.setOpenVpnAsgToOneFn)],
            });

            // add scheduled rule to scale down
            this.scaleDownRule = new Rule(this, 'RemoveCapacityRule', {
                enabled: true,
                schedule: props.removeCapacitySchedule,
                targets: [new LambdaFunction(this.setOpenVpnAsgToZeroFn)],
            });
        }

        this.openVpnUrlCfnOutput = new cdk.CfnOutput(this, 'OpenVpnUrl', {
            value: `https://${region}.vpn.${zoneName}/admin`,
            description: `The OpenVPN web interface URL for Administrators`,
            exportName: `${id}-OpenVpnUrl`,
        });
    }

    /**
     * Obtain all required parameters from the Parameter Store
     * @returns {ConfigurationParameters} An object containing all the parameters from the parameter store
     */
    public getParametersFromStore(): ConfigurationParameters {
        // get email to be used for Lets Encrypt cert
        const certEmail = ssm.StringParameter.valueFromLookup(
            this,
            'cert-email'
        );

        // get parameters from SSM
        const hostedZone = ssm.StringParameter.valueFromLookup(
            this,
            'openvpn-hosted-zone'
        );

        // hosted zone name
        const zoneName = ssm.StringParameter.valueFromLookup(
            this,
            'openvpn-zone-name'
        );

        // openvpn access server admin pasword
        const adminPassword = ssm.StringParameter.valueFromLookup(
            this,
            'openvpn-admin-passwd'
        );

        // ssh key name for open vpn instances
        const openVpnKeyName = ssm.StringParameter.valueFromLookup(
            this,
            'openvpn-keyname'
        );

        // ssh key name for pi hole instances
        const piHoleKeyName = ssm.StringParameter.valueFromLookup(
            this,
            'pihole-keyname'
        );

        // ssh key name for pi hole instances
        const piHoleWebPassword = ssm.StringParameter.valueFromLookup(
            this,
            'pihole-webpassword'
        );

        // get the VPN username to be set
        const vpnUsername = ssm.StringParameter.valueFromLookup(
            this,
            'openvpn-user-name'
        );

        // get the VPN user password to be set
        const vpnPassword = ssm.StringParameter.valueFromLookup(
            this,
            'openvpn-user-passwd'
        );

        // get the npm tag to use when installing user data scripts
        const userDataScriptsVersionTag = ssm.StringParameter.valueFromLookup(
            this,
            'ec2-user-data-scripts-version-tag'
        );

        // get the environment to use when requesting certs
        const letsEncryptCertEnv = ssm.StringParameter.valueFromLookup(
            this,
            'lets-encrypt-cert-env'
        );

        return {
            certEmail,
            hostedZone,
            zoneName,
            adminPassword,
            openVpnKeyName,
            piHoleKeyName,
            piHoleWebPassword,
            vpnUsername,
            vpnPassword,
            userDataScriptsVersionTag,
            letsEncryptCertEnv,
        };
    }

    /**
     * Custom tags to be appended to all tagable children and the construct.
     * Custom tags are useful for creating accurate cost/billing reports for resources created by this stack.
     */
    public setupTags(stackId: string, region: string, account: string): void {
        const includedResources: string[] = [
            'AWS::EC2::Instance', // Tag all EC2 instances
            'AWS::S3::Bucket', // Tag S3 Buckets
            'AWS::SNS::Topic', // Tag SNS topics
            'AWS::EC2::EIP', // Tag Elastic IP
            'AWS::EC2::VPC', // Tag VPC
            'AWS::EC2::Subnet', // Tag subnets
            'AWS::EC2::SecurityGroup', // Tag security groups
            'AWS::AutoScaling::AutoScalingGroup', // Tag the ASG
            'AWS::IAM::Role', // Tag IAM roles
            'AWS::Lambda::Function', // Tag lambda
            'AWS::Logs::LogGroup', // Tag log groups
        ];

        Tags.of(this).add('OpenVpnStackId', stackId);
        Tags.of(this).add('OpenVpnRegion', region);
        Tags.of(this).add('OpenVpnAccount', account);
        Tags.of(this).add('OpenVpnCodeVersion', packageJson.version);
        Tags.of(this).add(
            'OpenVpnDeploymentTimestamp',
            new Date().toISOString()
        );
    }

    private escapeRegExp(input: unknown): string {
        const source =
            typeof input === 'string' || input instanceof String ? input : '';
        return source.replace(/[-[/\]{}()*+?.,\\^$|#\s]/g, '\\$&');
    }
}
