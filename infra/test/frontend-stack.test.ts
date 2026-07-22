import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { FrontendStack } from "../lib/frontend-stack";

const synth = (): Template => {
  const app = new cdk.App();
  const stack = new FrontendStack(app, "TestFrontend", {
    env: { account: "123456789012", region: "ap-northeast-1" },
  });
  return Template.fromStack(stack);
};

test("SPA fallback maps 403/404 to index.html", () => {
  const template = synth();
  template.hasResourceProperties("AWS::CloudFront::Distribution", {
    DistributionConfig: Match.objectLike({
      DefaultRootObject: "index.html",
      CustomErrorResponses: Match.arrayWith([
        Match.objectLike({ ErrorCode: 403, ResponseCode: 200, ResponsePagePath: "/index.html" }),
        Match.objectLike({ ErrorCode: 404, ResponseCode: 200, ResponsePagePath: "/index.html" }),
      ]),
    }),
  });
});

test("bucket blocks public access (served via OAC only)", () => {
  const template = synth();
  template.hasResourceProperties("AWS::S3::Bucket", {
    PublicAccessBlockConfiguration: Match.objectLike({ BlockPublicPolicy: true }),
  });
});
