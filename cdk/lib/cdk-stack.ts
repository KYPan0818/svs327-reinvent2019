import cdk = require('@aws-cdk/core');
import apigateway = require('@aws-cdk/aws-apigateway');
import lambda = require('@aws-cdk/aws-lambda');
import sns = require('@aws-cdk/aws-sns');
import subscription = require('@aws-cdk/aws-sns-subscriptions');
import sqs = require('@aws-cdk/aws-sqs');
import iam = require('@aws-cdk/aws-iam');
import { CfnOutput } from '@aws-cdk/core';
import ddb = require('@aws-cdk/aws-dynamodb');
import path = require('path');
import { SqsEventSource, DynamoEventSource } from '@aws-cdk/aws-lambda-event-sources';
import { LambdaIntegration } from '@aws-cdk/aws-apigateway';

export class CdkStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // The code that defines your stack goes here
    const api = new apigateway.RestApi(this, 'my-api');
    const book = api.root.addResource('book');
    const query = api.root.addResource('query');
    const integApig2Snsrole = new iam.Role(this, 'IntegApig2SnsRole', {
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
    });

    // const topic = sns.Topic.fromTopicArn(this, 'Topic', 'arn:aws:sns:us-west-2:903779448426:SNS2IM')

    const topic = this.node.tryGetContext('SNS_TOPIC_ARN') ? 
      sns.Topic.fromTopicArn(this, 'Topic', this.node.tryGetContext('SNS_TOPIC_ARN')) : new sns.Topic(this, 'Topic')



    // new sns.Subscription(this, 'EmailMe', {
    //   protocol: sns.SubscriptionProtocol.EMAIL,
    //   endpoint: 'pahudnet@gmail.com',
    //   topic
    // });


    new CfnOutput(this, 'TopicArn', { value: topic.topicArn })
    const queue = new sqs.Queue(this, 'Queue')

    new cdk.CfnOutput(this, 'QueueName', { value: queue.queueName })
    topic.addSubscription(new subscription.SqsSubscription(queue))


    // const topic = new sns.Topic(this, 'Topic')
    // new sns.Subscription(this, 'EmailMe', {
    //   protocol: sns.SubscriptionProtocol.EMAIL,
    //   endpoint: 'pahudnet@gmail.com',
    //   topic
    // });
    // topic.addSubscription(
    // }))

    const integApig2Sns = new apigateway.AwsIntegration({
      service: 'sns',
      // action: 'Publish',
      path: '/publish',
      proxy: false,
      integrationHttpMethod: 'POST',
      options: {
        credentialsRole: integApig2Snsrole,
        requestParameters: {
          'integration.request.header.Content-Type': '\'application/x-www-form-urlencoded\''
        },
        requestTemplates: {
          'application/json': `Action=Publish&TopicArn=$util.urlEncode('${topic.topicArn}')&Message=$util.urlEncode($input.body)`,
        },
        passthroughBehavior: apigateway.PassthroughBehavior.NEVER,
        integrationResponses: [
          {
            statusCode: '200',
            responseTemplates: { 'application/json': '$input.json("$")' },
            // responseTemplates: { 'application/json': JSON.stringify({ success: true }) },
          },
          {
            selectionPattern: 'Invalid',
            statusCode: '503',
            responseTemplates: { 'application/json': JSON.stringify({ success: false, message: 'Invalid Request' }) },
          },
        ],
      }
    });


    // create integration response programmatically:
    var statuses: { [index: string]: string; } = {
      "200": "",
      "400": "[\s\S]*\[400\][\s\S]*",
      "401": "[\s\S]*\[401\][\s\S]*",
      "403": "[\s\S]*\[403\][\s\S]*",
      "404": "[\s\S]*\[404\][\s\S]*",
      "422": "[\s\S]*\[422\][\s\S]*",
      "500": "[\s\S]*(Process\s?exited\s?before\s?completing\s?request|\[500\])[\s\S]*",
      "502": "[\s\S]*\[502\][\s\S]*",
      "504": "([\s\S]*\[504\][\s\S]*)|(^[Task timed out].*)"
    }

    // // create integration response
    // var integrationResponses: apigateway.IntegrationResponse[] = [];
    // for (let status in statuses) {
    //   var selectionPattern = statuses[status];
    //   integrationResponses.push({
    //     statusCode: status,
    //     selectionPattern: selectionPattern,
    //     responseParameters: {
    //       "method.response.header.Access-Control-Allow-Origin": "'''*'''"
    //     },
    //     responseTemplates: {}
    //   })
    // }

    // create method response
    var methodResponses: apigateway.MethodResponse[] = [];
    for (let status in statuses) {
      // var selectionPattern = statuses[status];
      methodResponses.push({
        statusCode: status,
        // responseParameters: {
        //   "method.response.header.Access-Control-Allow-Origin": true
        // },
        responseModels: {}
      })
    }

    book.addMethod('POST', integApig2Sns, {
      methodResponses
    });



    new cdk.CfnOutput(this, 'BookingAPIEndpoint', { value: `${book.url}` })
    new cdk.CfnOutput(this, 'BookCommand', {
      value: `curl -XPOST -H 'content-type: application/json' ${book.url}`
    })


    topic.grantPublish(integApig2Snsrole)

    // DynamoDB Table
    const table = new ddb.Table(this, 'Table', {
      partitionKey: {
        name: 'message_id',
        type: ddb.AttributeType.STRING
      },
      stream: ddb.StreamViewType.NEW_IMAGE,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    })
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName })

    // QueueProcessor
    const fnQueueProcessor = new lambda.Function(this, 'fnQueueProcessor', {
      runtime: lambda.Runtime.PYTHON_3_7,
      code: lambda.AssetCode.fromAsset(path.join(__dirname, '../', 'functions/QueueProcessor/fn/')),
      handler: 'app.lambda_handler',
      environment: {
        TABLE_NAME: table.tableName
      }
    });

    // FullfillmentHandler
    const fnFullfillment = new lambda.Function(this, 'fnFullfillment', {
      runtime: lambda.Runtime.PYTHON_3_7,
      code: lambda.AssetCode.fromAsset(path.join(__dirname, '../', 'functions/FullfillmentHandler/fn/')),
      handler: 'app.lambda_handler',
      environment: {
        TABLE_NAME: table.tableName
      }
    });   

    // QueryBookingHandler
    const fnQueryBooking = new lambda.Function(this, 'fnQueryBooking', {
      runtime: lambda.Runtime.PYTHON_3_7,
      code: lambda.AssetCode.fromAsset(path.join(__dirname, '../', 'functions/QueryBookingStatus/fn/')),
      handler: 'app.lambda_handler',
      environment: {
        TABLE_NAME: table.tableName
      }
    });    

    // allow ANY method on /query
    query.addProxy({
      defaultIntegration: new LambdaIntegration(fnQueryBooking),
      anyMethod: true 
    })
    new cdk.CfnOutput(this, 'QueryAPIEndpoint', { value: `${query.url}/{message_id}` })

    fnQueueProcessor.addEventSource(new SqsEventSource(queue))
    table.grantReadWriteData(fnQueueProcessor)
    fnFullfillment.addEventSource(new DynamoEventSource(table, {
      startingPosition: lambda.StartingPosition.LATEST
    }))
    table.grantStreamRead(fnFullfillment)
    table.grantReadWriteData(fnFullfillment)
    table.grantReadData(fnQueueProcessor)
    table.grantReadWriteData(fnQueryBooking)
  }
}
