import * as cdk from "aws-cdk-lib";
import * as lambdanode from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import * as events from "aws-cdk-lib/aws-lambda-event-sources";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
import * as iam from "aws-cdk-lib/aws-iam";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb"
import { Construct } from "constructs";

export class EDAAppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const imagesBucket = new s3.Bucket(this, "images", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      publicReadAccess: false,
    });

    // New image table, using file name as primary key.
    const imageTable = new dynamodb.Table(this, "ImageTable", {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST, // added billing mode as that's what I had in CA1
      partitionKey: { name: "FileName", type: dynamodb.AttributeType.STRING },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      tableName: "ImagesT",
    });
    
    // Integration infrastructure

    // intermediate queue no longer needed.
    // const mailerQ = new sqs.Queue(this, "mailer-queue", {
    //   receiveMessageWaitTime: cdk.Duration.seconds(10),
    // });

    //create new DLQ - untested
    const deadLetterQ = new sqs.Queue(this, "deadLetter-queue", { 
      //receiveMessageWaitTime: cdk.Duration.seconds(10),
      queueName: "deadLetterQueue"
    });
 

    const imageProcessQueue = new sqs.Queue(this, "img-created-queue", {
      receiveMessageWaitTime: cdk.Duration.seconds(10),
      deadLetterQueue: {
        queue: deadLetterQ,
        maxReceiveCount: 1
      },
      retentionPeriod: cdk.Duration.seconds(60) // must be 60 seconds or more.
    });


    // Topics

    const newImageTopic = new sns.Topic(this, "NewImageTopic", {
      displayName: "New Image topic",
    });

    // Lambda functions

    const processImageFn = new lambdanode.NodejsFunction(
      this,
      "ProcessImageFn",
      {
        // architecture: lambda.Architecture.ARM_64,
        runtime: lambda.Runtime.NODEJS_18_X,
        entry: `${__dirname}/../lambdas/processImage.ts`,
        timeout: cdk.Duration.seconds(15),
        memorySize: 128,
        deadLetterQueue: deadLetterQ
      }
    );

    const mailerFn = new lambdanode.NodejsFunction(this, "mailer-function", {
      runtime: lambda.Runtime.NODEJS_16_X,
      memorySize: 1024,
      timeout: cdk.Duration.seconds(3),
      entry: `${__dirname}/../lambdas/mailer.ts`,
    });

    const rejectionMailerFn = new lambdanode.NodejsFunction(this, "rejection-mailer-function", {
      runtime: lambda.Runtime.NODEJS_16_X,
      memorySize: 128,
      timeout: cdk.Duration.seconds(3),
      entry: `${__dirname}/../lambdas/rejectionMailer.ts`,
    });

    // Event triggers

    imagesBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.SnsDestination(newImageTopic)  // Changed
    );

    const newImageEventSource = new events.SqsEventSource(imageProcessQueue, {
      batchSize: 5,
      maxBatchingWindow: cdk.Duration.seconds(10),
    });

    // intermediate event source no longer needed
    // const newImageMailEventSource = new events.SqsEventSource(mailerQ, {
    //   batchSize: 5,
    //   maxBatchingWindow: cdk.Duration.seconds(10),
    // });

    const rejectionMailerEventSource = new events.SqsEventSource(deadLetterQ, {
      batchSize: 5,
      maxBatchingWindow: cdk.Duration.seconds(10),
    });


    newImageTopic.addSubscription(
      new subs.SqsSubscription(imageProcessQueue, {
        filterPolicy: {
          imageType: sns.SubscriptionFilter.stringFilter({
            allowlist: ['.jpeg', '.png'],
          }),
        },
      }),
    );

    // routes images to dlq based on file extension
    newImageTopic.addSubscription(
      new subs.SqsSubscription(deadLetterQ, {
        filterPolicy: {
          imageType: sns.SubscriptionFilter.stringFilter({
            denylist: ['.jpeg', '.png'],
          }),
        },
      }),
    );

    // intermediate queue is no longer a subscriber to topic
    // newImageTopic.addSubscription(
    //   new subs.SqsSubscription(mailerQ)
    //   );
    // instead, the lambda needs to be directly subscribed to the SNS topic
    // that can be done with the subs.LambdaSubscription(lambda_fn)
    const lambdaSub = new subs.LambdaSubscription(mailerFn)
    newImageTopic.addSubscription(lambdaSub);

    processImageFn.addEventSource(newImageEventSource);

    mailerFn.addEventSource(newImageMailEventSource);

    rejectionMailerFn.addEventSource(rejectionMailerEventSource);

    // Permissions

    imagesBucket.grantRead(processImageFn);
    imageTable.grantReadWriteData(processImageFn);

    mailerFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "ses:SendEmail",
          "ses:SendRawEmail",
          "ses:SendTemplatedEmail",
        ],
        resources: ["*"],
      })
    );

    rejectionMailerFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "ses:SendEmail",
          "ses:SendRawEmail",
          "ses:SendTemplatedEmail",
        ],
        resources: ["*"],
      })
    );

    // Output
    
    new cdk.CfnOutput(this, "bucketName", {
      value: imagesBucket.bucketName,
    });


  }
}
