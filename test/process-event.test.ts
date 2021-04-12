import * as aws from 'aws-sdk';
import * as AWSMock from 'aws-sdk-mock';

describe('ProcesEventFn', () => {
    beforeEach(() => {
        AWSMock.setSDKInstance(aws);

        AWSMock.mock(
            'Route53',
            'changeResourceRecordSets',
            (
                params: aws.Route53.ChangeResourceRecordSetsRequest,
                callback: Function
            ) => {
                callback(null, {} as aws.Route53.ChangeResourceRecordSetsResponse);
            }
        )

        AWSMock.mock(
            'EC2',
            'modifyInstanceAttribute',
            (
                params: aws.EC2.ModifyAddressAttributeRequest,
                callback: Function
            ) => {
                callback(null, {} as aws.EC2.ModifyAddressAttributeResult);
            }
        );

        AWSMock.mock(
            'EC2',
            'disassociateAddress',
            (
                params: aws.EC2.DisassociateAddressRequest,
                callback: Function
            ) => {
                callback(null, {} as aws.EC2.DisassociateAddressRequest);
            }
        );

        AWSMock.mock(
            'EC2',
            'associateAddress',
            (params: aws.EC2.AssociateAddressRequest, callback: Function) => {
                callback(null, {} as aws.EC2.AssociateAddressResult);
            }
        );

        AWSMock.mock(
            'EC2',
            'describeAddresses',
            (params: aws.EC2.AssociateAddressRequest, callback: Function) => {
                callback(null, {
                    Addresses: [],
                } as aws.EC2.AssociateAddressResult);
            }
        );
        AWSMock.mock(
            'EC2',
            'describeInstances',
            (params: aws.EC2.DescribeInstancesRequest, callback: Function) => {
                callback(null, {} as aws.EC2.DescribeInstancesResult);
            }
        );
    });

    afterEach((done) => {
        AWSMock.restore();
        done();
    });

    test.todo('Test me');
});
