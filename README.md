# Self Hosted OpenVPN Access Server with Recursive DNS 

This infrastructure _is_ code (using AWS CDK) repository provisions relevant resources needed for a scalable self hosted VPN server in AWS.

The VPN server will be configured to use a recursive DNS (PiHole + Unbound) that is also set up by this code.

This repository attempts to automate as much of the setup process as possible so that it can serve as a "one click" deployment for a fully functional VPN and DNS service that you can then own and manage, thus giving you ownership over your footprint on the internet.

- [Self Hosted OpenVPN Access Server with Recursive DNS](#self-hosted-openvpn-access-server-with-recursive-dns)
  - [Credits](#credits)
  - [Prerequisites](#prerequisites)
  - [Deployment](#deployment)
  - [Destroy](#destroy)
  - [License agreement](#license-agreement)
  - [SSH Keys](#ssh-keys)
  - [SSM Parameters](#ssm-parameters)
  - [Troubleshooting](#troubleshooting)
    - [General reminders](#general-reminders)
    - [For the Pi Hole EC2 image](#for-the-pi-hole-ec2-image)
    - [For the OpenVPN Instance](#for-the-openvpn-instance)
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
3. Your own domain name. _In my case, I purchased my domain name directly from AWS which automatically created a public Hosted Zone in Route53 for me. This setup does not cover manual creation of Hosted Zones for domain names registered outside AWS_
4. An understanding that this setup incurs cost since it is deployed on AWS. The `t2.micro` EC2 instances used are free tier for *12 months* for *new* customers only. Use the TCO calculator to get an estimate of your costs by using this infrastructure and modify the instance type if needed (I cannot vouch for the stability of the setup for different instance types, try it and let me know :smile:) 
   1. EBS storage connected to EC2 instances are also chargeable. The PiHole EC2 instance is equipped with a 20GB EBS volume to cater for caching and adlists created/used by PiHole.
## Deployment

Fork this repo, run `npm install`.

`cdk` version has been locked to `1.95.1`

> Before running the deploy command, make sure you read all the instructions in this readme. It's worth it because if you don't, chances are the deployment will not work.

A batch file and NPM script has been made to simplify deployment.

In a Command Prompt or Powershell, run:

```powershell
npm run cdk:deploy -- <YOUR_AWS_ACCOUNT_ID> <AWS_REGION> --profile <YOUR_IAM_PROFILE>
```

Remember to replace the arguments accordingly with your AWS Account ID and AWS region along with an IAM profile that has the necessary rights to create resources on that AWS account.

If this is your very first time running CDK to deploy infrastructure to your AWS account, you may see an error when running the deployment related to a need for a [bootstrapping command](https://stackoverflow.com/questions/60347678/purpose-and-scope-of-aws-cdk-bootstrap-stack) to be executed first. Follow the instructions in the error message and the error will go away.

The bootstrap command should resemble this:

```powershell
npx cdk@1.95.1 bootstrap aws://<YOUR_AWS_ACCOUNT_ID>/<AWS_REGION> --profile <YOUR_IAM_PROFILE>
```
> Remember: Bootstrapping is a one time operation. You don't need to bootstrap CDK if you've already done it before for the account in question.

## Destroy

Teardown is easy with the supplied batch script:

```powershell
npm run cdk:destroy -- <YOUR_AWS_ACCOUNT_ID> <AWS_REGION> --profile <YOUR_IAM_PROFILE>
```

This removes pretty much everything created by this stack so that you are not charged for resources on AWS that you are no longer using.
## License agreement

OpenVPN Access Server AMI requires that you manually [accept the license agreement](https://github.com/mattmcclean/openvpn-cdk-demo/issues/1) before using the image.

Make sure you go to Amazon Marketplace Subscriptions and subscribe to the AMI that you are using to spin up EC2 instances in this code and accept the license agreement to use the image.

The OpenVPN Auto Scaling Group will not be able to launch any EC2 instances with this image if the license agreement is not accepted.
## SSH Keys

The code will use predefined SSH key names when defining auto scaling groups so that we can access the ec2 instances spawned using SSH.
Please note that they key should first be created in the account _manually_ by going to `EC2 > Network & Security > Key Pairs` and defining the key (either in `.ppk` or `.pem` format) _before_ deploying the infrastructure code. Creation of keys in this interface will result in either a `.ppk` or `.pem` file to be downloaded to your machine. Store these safely as you will need them later.
## SSM Parameters

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
 3. If you are accessing the Pi Hole web interface from the FQDN and get a timeout, remember that you are accessing a route53 domain mapping to the EC2 public IP that was recently created with the stack. It can take up to 2 hours before DNS records are propagated
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
4. If you are using a password with many special characters (i.e. contains `#` and `$`), you might encounter an issue whereby the encoding of the password is incorrect causing a login error in Pi Hole. This is a bug I am still working on fixing. However, the fix for this is to `ssh` into your pihole EC2 instance and re-run `pihole -a -p <password>` to set the password manually. This should resolve the issue and allow you to log in to the Pi Hole web interface.

### For the OpenVPN Instance

Try not to immediately use the OpenVPN Access Server after infrastructure deployment. This is because additional steps to run `certbot` may be running after EC2 instance creation. Wait at least 5 minutes before using the service.

1. The admin web UI can be accessed by the FQDN URL printed at the end of stack deployment as a `CfnOutput` or via the EC2 instance's public IP address or via it's public IPv4 DNS
2. Verify your OpenVPN config using
   ```bash
      sudo /usr/local/openvpn_as/scripts/sacli ConfigQuery
      ```
3. Tail the setup log via `tail -f -n 100 /var/log/cloud-init-output.log` or `cat` the same file to see everything.


## Known Issues

### TCP vs UDP 

By default the OpenVPN Access Server is configured to utilize both UDP and TCP daemons for routing traffic. The OpenVPN client by default will attempt to connect to the OpenVPN Access Server using **UDP**. If this fails or is not configured, it then falls back to use **TDP**. This distinction is important as the stability of some applications are affected by this choice of protocol.

Some applications will start freezing when OpenVPN traffic is routed via UDP. At the time of writing (6th April 2021), I noticed that the following applications would only work if I configured the OpenVPN **client** to only use TCP protocol when connecting to the OpenVPN Server for routing traffic:

1. Citrix Netscaler Gateway

## Features

### The Auto Scaling Group

The OpenVPN instance is configured to be scaled up or down in an Auto Scaling Group. This mechanism has been put into place to create cost savings on EC2 instance uptime by destroying the OpenVPN server everyday at 2am Malaysian Time and then recreating it again at 7.45am Malaysian time. Because Cloudwatch Scheduled events can only be defined in UTC times, the scale up and scale down times listed above are adjusted accordingly in the `cron` expression. 

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

The deployment includes 3 custom/user defined tags that can be used in AWS Cost Explorer or Billing to understand how much your setup is costing you per month.

   - `OpenVpnStackId`: A unique ID identifying the stack (default is `OpenVpnAccessServerInfraStack`) 
   - `OpenVpnRegion`: The region to which the stack is deployed to
   - `OpenVpnAccount`: The AWS account where the stack resides in
   - `OpenVpnCodeVersion`: The version of the code in `package.json`
   - `OpenVpnDeploymentTimestamp`: The ISO timestamp of the deployment

Using these tags, set up an appropriate Budget or Cost Report to understand usage trends to see how much you are being charged for this setup in AWS. 

## CDK Context Management

Use `npm run cdk -- context` to view the context keys and values that CDK will use for the deployment of this stack.
The context will include many SSM properties that are fetched on synthesis and "baked in" to the CloudFormation output.