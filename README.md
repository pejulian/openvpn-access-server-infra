# Self Hosted VPN with Recursive DNS 

[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC) [![PR's Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat)](http://makeapullrequest.com)  


This infrastructure _is_ code (using AWS CDK) repository provisions relevant resources needed for a scalable self hosted VPN server in AWS.

An [OpenVPN](https://openvpn.net/) server will be configured to use a recursive DNS ([PiHole](https://pi-hole.net/) + [Unbound](https://www.nlnetlabs.nl/projects/unbound/about/)) that is also set up by this code.

This repository attempts to automate as much* of the setup process as possible so that it can serve as a "one click" deployment for a fully functional VPN and DNS service that you can then own and manage, thus giving you ownership over your footprint on the internet.

<small>_* some manual (one time) set up is still required for first time deployments_</small>

- [Self Hosted VPN with Recursive DNS](#self-hosted-vpn-with-recursive-dns)
  - [Credits](#credits)
  - [Prerequisites](#prerequisites)
  - [Deployment](#deployment)
  - [Destroy](#destroy)
  - [Manual steps before installation](#manual-steps-before-installation)
    - [License agreement](#license-agreement)
    - [SSH Keys](#ssh-keys)
    - [Hosted Zone](#hosted-zone)
    - [SSM Parameters](#ssm-parameters)
  - [Troubleshooting](#troubleshooting)
    - [General reminders](#general-reminders)
    - [For the Pi Hole EC2 image](#for-the-pi-hole-ec2-image)
    - [For the OpenVPN Instance](#for-the-openvpn-instance)
    - [Manually setting the Auto Scaling Group](#manually-setting-the-auto-scaling-group)
  - [Known Issues](#known-issues)
    - [TCP vs UDP](#tcp-vs-udp)
  - [Features](#features)
    - [The Auto Scaling Group](#the-auto-scaling-group)
    - [unbound](#unbound)
    - [certbot](#certbot)
    - [pihole tools](#pihole-tools)
  - [Billing Features](#billing-features)
  - [CDK Context Management](#cdk-context-management)


## Credits

Making all this wouldn't have been possible without the wisdom of these awesome folks:

1. [Craft Computing](https://www.youtube.com/watch?v=FnFtWsZ8IP0)
2. [mattmcclean](https://github.com/mattmcclean/openvpn-cdk-demo)
3. [NetworkChuck](https://www.youtube.com/watch?v=m-i2JBtG4FE)
4. [Binary Kings](https://www.youtube.com/watch?v=Ip2VcWmO88M)

... along with a ton of StackOverflow and ServerFault resources that helped along the way.
## Prerequisites

1. `nodejs@12x` and `npm`
2. `PuTTY` or similar SSH client (or command line if you prefer that)
3. Complete these [manual set up steps](#manual-steps-before-installation)
4. An understanding that this setup incurs a monthly costs since it is deployed on AWS. The `t3a.micro` EC2 instances defined in the code are _NOT_ within the free tier for new AWS account signups. Use `t2.micro` instances to get 750 hours for *12 months* if signing up as a *new* customer. Use the TCO calculator to get an estimate of your costs by using this infrastructure and modify the instance type if needed (I cannot vouch for the stability of the setup for different instance types, try it and let me know :smile:). If you will be paying for this setup, consider setting up a Budget or Billing Alarm to better monitor your monthly costs.
   1. EBS storage connected to EC2 instances are also chargeable. The PiHole EC2 instance is equipped with a 20GB EBS volume to cater for caching and adlists created/used by PiHole.
## Deployment

Fork this repo, run `npm install`.

> `cdk` version has been locked to `1.98.0` to prevent package conflicts.

> Before running the deploy command, ensure that you have read all the instructions in this readme. It's worth taking the time to do so as chances are the deployment will not work if certain pre-requisites steps aren't met.

A batch file and NPM script has been made to simplify deployment.

In a Command Prompt or Powershell, run:

```powershell
npm run cdk:deploy -- <YOUR_AWS_ACCOUNT_ID> <AWS_REGION> --profile <YOUR_IAM_PROFILE>
```

Remember to replace the arguments accordingly with your AWS Account ID and AWS region along with an IAM profile that has the necessary rights to create resources on that AWS account.

If this is your very first time running CDK to deploy infrastructure to your AWS account, you may see an error when running the deployment related to a need for a [bootstrapping command](https://stackoverflow.com/questions/60347678/purpose-and-scope-of-aws-cdk-bootstrap-stack) to be executed first. Follow the instructions in the error message and the error will go away.

The bootstrap command should resemble this:

```powershell
npx cdk@1.98.0 bootstrap aws://<YOUR_AWS_ACCOUNT_ID>/<AWS_REGION> --profile <YOUR_IAM_PROFILE>
```
> Bootstrapping is a one time operation. You don't need to bootstrap CDK every time you make a deployment for the given AWS account..

## Destroy

Teardown is easy with the supplied batch script:

```powershell
npm run cdk:destroy -- <YOUR_AWS_ACCOUNT_ID> <AWS_REGION> --profile <YOUR_IAM_PROFILE>
```

This removes pretty much everything created by this stack so that you are not charged for resources on AWS that you are no longer using.

Some notes:
1. Cloudwatch Log Groups created by this stack are not deleted. Only the log entries themselves will be cleared out.
2. The S3 bucket created by CDK bootstrap is not deleted.
## Manual steps before installation

There are some manual steps that have to be done in the AWS Console before running the CDK deploy function. This is to ensure your account is properly set up before deploying infrastructure on to it.
### License agreement

OpenVPN Access Server AMI requires that you manually [accept the license agreement](https://github.com/mattmcclean/openvpn-cdk-demo/issues/1) before using the image.

Make sure you go to Amazon Marketplace Subscriptions and subscribe to the AMI that you are using to spin up EC2 instances in this code and accept the license agreement to use the image.

The OpenVPN Auto Scaling Group will not be able to launch any EC2 instances with this image if the license agreement is not accepted.
### SSH Keys

The code will use predefined SSH key names when defining auto scaling groups so that we can access the ec2 instances spawned using SSH.
Please note that they key should first be created in the account _manually_ by going to `EC2 > Network & Security > Key Pairs` and defining the key (either in `.ppk` or `.pem` format) _before_ deploying the infrastructure code. Creation of keys in this interface will result in either a `.ppk` or `.pem` file to be downloaded to your machine. Store these safely as you will need them later.

### Hosted Zone

You will need a registered domain name for this setup to work properly.

_In my case, I purchased my domain name directly from AWS which automatically created a public Hosted Zone in Route53 for me. While it is possible to create a Hosted Zone based on a domain name that has been registered outside AWS, that is beyond the scope of this readme._
### SSM Parameters

Before deploying infrastructure, set up SSM with the following parameters so that OpenVPN access server & PiHole may be configured properly.
Take note of the parameters set as these will be required later when using the service.

For `openvpn-hosted-zone` and `openvpn-zone-name`, you must first have a Hosted Zone created in Route53 that corresponds to the your domain. `openvpn-keyname` and `pihole-keyname` respectively are the key names that you created in `Key Pairs` page and will be used for SSH access.
`openvpn-user-name` and `openvpn-user-passwd` will be the username you enter in the OpenVPN client to connect to the Access Server

```bash
aws ssm put-parameter --name "openvpn-hosted-zone" --value <HOSTED_ZONE_ID> --type String --profile <YOUR_IAM_PROFILE> --region <AWS_REGION>
aws ssm put-parameter --name "openvpn-zone-name" --value <DOMAIN_NAME> --type String --profile <YOUR_IAM_PROFILE> --region <AWS_REGION>
aws ssm put-parameter --name "openvpn-admin-passwd" --value <OPEN_VPN_ADMIN_PASSWORD> --type String --profile <YOUR_IAM_PROFILE> --region <AWS_REGION>
aws ssm put-parameter --name "openvpn-keyname" --value <KEY_NAME_1> --type String --profile <YOUR_IAM_PROFILE> --region <AWS_REGION>
aws ssm put-parameter --name "openvpn-user-name" --value <OPEN_VPN_USERNAME> --type String --profile <YOUR_IAM_PROFILE> --region <AWS_REGION>
aws ssm put-parameter --name "openvpn-user-passwd" --value <OPEN_VPN_USERPASSWORD> --type String --profile <YOUR_IAM_PROFILE> --region <AWS_REGION>
aws ssm put-parameter --name "pihole-keyname" --value <KEY_NAME_2> --type String --profile <YOUR_IAM_PROFILE> --region <AWS_REGION>
aws ssm put-parameter --name "pihole-webpassword" --value <SECURE_PASSWORD> --type String --profile <YOUR_IAM_PROFILE> --region <AWS_REGION>
aws ssm put-parameter --name "cert-email" --value <YOUR_EMAIL> --type String --profile <YOUR_IAM_PROFILE> --region <AWS_REGION>
aws ssm put-parameter --name "ec2-user-data-scripts-version-tag" --value <latest|beta> --type String --profile <YOUR_IAM_PROFILE> --region <AWS_REGION>
aws ssm put-parameter --name "lets-encrypt-cert-env" --value <staging|production> --type String --profile <YOUR_IAM_PROFILE> --region <AWS_REGION>
```

`ec2-user-data-scripts-version-tag` refers to the `npm` release tag to be used when running `npx` to fetch unattended install scripts for OpenVPN and Pi Hole. If unsure what to use, set the value to `latest`. 

`lets-encrypt-cert-env` refers to the Lets Encrypt server to use when requesting SSL certificates. Use `production` to issue valid SSL certificates for actual use and `staging` for development purposes. Remember that Lets Encrypt has "rate limits" for `production` certificate generations (limited to 5 identical domain name certificate requests a week), so definitely use `staging` if doing some sort of testing and frequent redeployments.

## Troubleshooting 

Below are some steps that can help you troubleshoot your setup.

### General reminders

   1. The OpenVPN web ui administrator username is the generic one created during install (`openvpn`)
   2. The SSH user for OpenVPN instance is `openvpnas` (this follows the recommendation from the OpenVPN Amazon Linux Image)
   4. The SSH user for PiHole instance is `ubuntu` (the default user of an Ubuntu image)

### For the Pi Hole EC2 image

It _may not_ be immediately possible to access the Pi Hole web interface after infrastructure deployment. Read the following to understand more:

 1. Did you wait at least 5 minutes after stack creation completed before trying to hit the URL(s)? 
    1. You should at least wait 5 minutes for things to get properly installed because the `userData` script for the Pi Hole instance is doing additional work on the Ubuntu OS _after_ the instance is created
 2. Remember that the PiHole web interface is accessed using HTTP
 3. If you login to your Pi Hole admin dashboard and see that the FTL service failed to start, it could be that your EC2 instance type uses a differently named network interface (the hardcoded one is `ens5`). Run `ifconfig` to view the network interfaces configured for your instance and modify the `PIHOLE_INTERFACE` value in `/etc/pihole/setupVars.conf` with the correct network interface name and finally, restart the pihole service ussing `pihole restartdns`.
    1. You can verify that the Pi Hole DNS service started up correctly by looking for this entry in the Pi Hole setup log (`/var/log/cloud-init-output.log`)
       ```bash
         [✓] DNS service is listening
            [✓] UDP (IPv4)
            [✓] TCP (IPv4)
            [✓] UDP (IPv6)
            [✓] TCP (IPv6)
       ``` 
 4. If you are accessing the Pi Hole web interface from the FQDN and get a timeout, remember that you are accessing a route53 domain mapping to the EC2 public IP that was recently created with the stack. It can take up to 2 hours before DNS records are propagated
    1. Try to access the Pi Hole web interface directly from the Public IP address instead (you can get the public IP by viewing the EC2 instance details in AWS console)
    2. If the above does not work, SSH into the instance to check if there are any error messages or requests for a restart
       1. Suggested verification steps:
          1. verify that `sudo id` works on terminal
          2. verify install output (`cat /var/log/cloud-init-output.log`)
          3. verify pihole configuration  (`cat /etc/pihole/setupVars.conf`)
       2. Attempt to resolve errors (there really shouldn't be any)
       3. Reboot the EC2 instance manually in the EC2 console and then try to access the Pi Hole web interface after a minute or so.
          1. Rebooting shouldnt change your EC2 IP address but it will restart network services that failed to update
       4. Verify that you can indeed access the web interface from the public IP address and the FQDN.
 5. If you want to change your Pi Hole web admin login passord, `ssh` into your pihole EC2 instance and run `pihole -a -p <password>` to set the password manually.

### For the OpenVPN Instance

Try not to immediately use the OpenVPN Access Server after infrastructure deployment. This is because additional steps to run `certbot` may be running after EC2 instance creation. Wait at least 5 minutes before using the service.

1. The admin web UI can be accessed by the FQDN URL printed at the end of stack deployment as a `CfnOutput` or via the EC2 instance's public IP address or via it's public IPv4 DNS
2. Verify your OpenVPN config using
   ```bash
      sudo /usr/local/openvpn_as/scripts/sacli ConfigQuery
      ```
3. Tail the setup log via `tail -f -n 100 /var/log/cloud-init-output.log` or `cat` the same file to see everything.
4. If you need to manually reset the VPN client's password, `ssh` into the OpenVPN EC2 instance then run:
   ```bash
   sudo /usr/local/openvpn_as/scripts/sacli --user <THE_USER> --new_pass "<NEW_PASSWORD>" SetLocalPassword
   ```
5. In the event your VPN clients are locked out, you can expedite the cooldown time by `ssh`ing into the OpenVPN EC2 instance and running the following:
   ```bash
   sudo /usr/local/openvpn_as/scripts/sacli stop
   sudo /usr/local/openvpn_as/scripts/sacli --key "vpn.server.lockout_policy.reset_time" --value "1" ConfigPut
   sudo /usr/local/openvpn_as/scripts/sacli start

   sudo /usr/local/openvpn_as/scripts/sacli stop
   sudo /usr/local/openvpn_as/scripts/sacli --key "vpn.server.lockout_policy.reset_time" ConfigDel
   sudo /usr/local/openvpn_as/scripts/sacli start
   ```

### Manually setting the Auto Scaling Group

If you would like to manually adjust the ASG capacity without waiting for set rules to trigger, you will need to manaully trigger the:

1. `OpenVpnAccessServerInfraStack-SetOpenVpnAsgToZeroFn` to set the ASG capacity to 0
2. `OpenVpnAccessServerInfraStack-SetOpenVpnAsgToOneFn` to set the ASG capacity to 1

Log in to AWS Console and go to the `Lambda` service, locate the above mentioned Lambda's and run the payloads below (in the "Test" tab) based on what setting you wish to set on the ASG.

**To set capacity to 0**

Sets the ASG capacity to 0 and subsequently deletes the EC2 instance (scale in)

```json
{
    "version": "0",
    "id": "7fd27b69-08bc-e133-78c3-692e4383a2d2",
    "detail-type": "Scheduled Event",
    "source": "aws.events",
    "account": "335952011029",
    "time": "2021-04-11T14:00:00Z",
    "region": "ap-southeast-1",
    "resources": [
        "arn:aws:events:ap-southeast-1:335952011029:rule/OpenVpnAccessServerInfraS-RemoveCapacityRuleDFA825-1A0NW9U7MI5YO"
    ],
    "detail": {}
}
```

**To set capacity to 1**

Sets the ASG capacity to 1 and subsequently creates an EC2 instance (scale out)

```json
{
    "version": "0",
    "id": "7fd27b69-08bc-e133-78c3-692e4383a2d2",
    "detail-type": "Scheduled Event",
    "source": "aws.events",
    "account": "335952011029",
    "time": "2021-04-11T14:05:00Z",
    "region": "ap-southeast-1",
    "resources": [
        "arn:aws:events:ap-southeast-1:335952011029:rule/OpenVpnAccessServerInfraS-OpenVpnAccessServerInfra-3ZG17NSXABDP"
    ],
    "detail": {}
}
```
## Known Issues

### TCP vs UDP 

By default the OpenVPN Access Server is configured to utilize both UDP and TCP daemons for routing traffic. The OpenVPN client by default will attempt to connect to the OpenVPN Access Server using **UDP**. If this fails or is not configured, it then falls back to use **TDP**. This distinction is important as the stability of some applications are affected by this choice of protocol.

Some applications will start freezing when OpenVPN traffic is routed via UDP. At the time of writing (6th April 2021), I noticed that the following applications would only work if I configured the OpenVPN **client** to only use TCP protocol when connecting to the OpenVPN Server for routing traffic:

1. Citrix Netscaler Gateway

## Features

### The Auto Scaling Group

An Auto Scaling Group (ASG) has been set up for the OpenVPN EC2 instance. This ASG is not intended to be a scale out solution to the VPN server but rather a cost savings mechanism by destroying the EC2 instance at a given timeframe in a day to create cost savings. Therefore, the desired capacity of the ASG should ever only need to be either 0 (for no instances) or 1 (1 OpenVPN instance). 

> The default setting of the ASG  will destroy the OpenVPN server every day at 2am Malaysian Time and then recreate it again at 7.45am Malaysian time.

Because Cloudwatch Scheduled events can only be defined in UTC time, the scale up and scale down times mentioned above are adjusted to UTC accordingly in the `cron` expressions. 

The current rule defined gives approximately 5 hours and 45 minutes of time in a day that you are not billed for a running OpenVPN instance.

If this rule doesn't fit your needs, feel free to adjust the Cloudwatch Rules for `addCapacitySchedule` and `removeCapacitySchedule` as needed.
### unbound

[unbound](https://docs.pi-hole.net/guides/dns/unbound/) is automatically set up in the PiHole EC2 instance to serve as a recursive DNS service to enhance PiHole. Most of the test validation steps you see in the `unbound` page is also integrated into the user data script of the PiHole instance. If you log in to your Pi Hole instance and go to DNS settings, you should see that a custom upstream server at `127.0.0.1#5335` has been set. This causes PiHole to forward DNS requests to `unbound` running on port 5335 instead of directly to a 3rd party DNS service. 
### certbot

The setup includes steps to provision a free SSL certificate via Certbot with an auto renewal cron to prevent the cert from expiring.

The certificate is generated against the domain that is mapped to the IP of the EC2 instance hosting OpenVPN Access Server and is identified by the provided `cert-email` from SSM. 

This generated certificate is `symlinked` to the relevant folder path in OpenVPN and therefore allows your OpenVPN web interface to be accessible via HTTPS without any pesky browser warnings of unverified providers.
### pihole tools

This setup comes with the [pihole5-list-tool](https://github.com/jessedp/pihole5-list-tool) installed.
Visit this page to learn how to use that tool to make your PiHole DNS stronger!

Simply SSH into this tool and begin using the tool via `sudo pihole5-list-tool`.

Personally, I would recommend adding [Firebog](https://firebog.net/)'s non-crossed lists to your setup as they contain a good collection of URLs to be blocked that instantaneously make your PiHole setup much better.

## Billing Features

The deployment includes 5 custom/user defined tags that can be used in AWS Cost Explorer or Billing to understand how much your setup is costing you per month.

   - `OpenVpnStackId`: A unique ID identifying the stack (default is `OpenVpnAccessServerInfraStack`) 
   - `OpenVpnRegion`: The region to which the stack is deployed to
   - `OpenVpnAccount`: The AWS account where the stack resides in
   - `OpenVpnCodeVersion`: The version of the code in `package.json`
   - `OpenVpnDeploymentTimestamp`: The ISO timestamp of the deployment

Using these tags, set up an appropriate Budget or Cost Report to understand usage trends to see how much you are being charged for this setup in AWS. 

## CDK Context Management

Use `npm run cdk -- context` to view the context keys and values that CDK will use for the deployment of this stack.
The context will include many SSM properties that are fetched on synthesis and "baked in" to the CloudFormation output.