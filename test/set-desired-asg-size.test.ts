import * as aws from 'aws-sdk';
import * as AWS from 'aws-sdk-mock';

AWS.setSDKInstance(aws);

afterEach((done) => {
    AWS.restore();
    done();
});

describe('SetDesiredAsgSizeFn', () => {
    test.todo('Test me');
});
