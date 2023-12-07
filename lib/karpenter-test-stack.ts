import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as cfninc from 'aws-cdk-lib/cloudformation-include';
import 'fs'
import { KubectlV27Layer } from '@aws-cdk/lambda-layer-kubectl-v27';

class KapenterResourcesStack extends cdk.NestedStack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps & {karpenterVersion: string, clusterName: string}) {
    super(scope, id, props);

    new cfninc.CfnInclude(this, 'KarpenterResources', {
      templateFile: `karpenter_${props?.karpenterVersion}.yaml`,
      parameters: {
        "ClusterName": props?.clusterName
      }
    });
  }
}

export class KarpenterTestStack extends cdk.Stack {
  createVpc(name: string) {
    const vpc = new ec2.Vpc(this, 'vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.18.0.0/18'),
      maxAzs: 2,
      subnetConfiguration: [
        {
          cidrMask: 20,
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 20,
          name: 'private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ]
    })
    cdk.Tags.of(vpc).add("Name", name)
    return vpc
  }

  createEKSCluster(vpc: ec2.IVpc, clusterName: string) {
    const mastersRole = new iam.Role(this, 'masters-role', {
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal(`eks.${cdk.Aws.URL_SUFFIX}`),
        new iam.AccountRootPrincipal(),
      ),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSClusterPolicy'),
      ]
    })

    return new eks.Cluster(this, 'cluster', {
      vpc,
      mastersRole,
      clusterName: clusterName,
      version: eks.KubernetesVersion.V1_27,
      kubectlLayer: new KubectlV27Layer(this, 'KubectlLayer'),
      defaultCapacity: 2,
      defaultCapacityInstance: new ec2.InstanceType('m5.large'),
    })
  }

  installKarpenter(cluster: eks.Cluster, karpenterVersion: string) {
    const karpenterResourcesStack = new KapenterResourcesStack(this, 'KarpenterResourcesStack', {
      stackName: "KarpenterResourcesStack",
      karpenterVersion,
      clusterName: cluster.clusterName
    })

    const controllerPolicy = iam.ManagedPolicy.fromManagedPolicyName(this, 'KarpenterControllerPolicy', `KarpenterControllerPolicy-${cluster.clusterName}`)
    const nodeRole = iam.Role.fromRoleName(this, 'KarpenterNodeRoleRef', `KarpenterNodeRole-${cluster.clusterName}`)
    const instanceProfileName = `KarpenterNodeInstanceProfile-${cluster.clusterName}`
    const interruptionQueueName = cluster.clusterName

    // resources that can be created by eksctl ClusterConfig
    const controllerRole = new iam.Role(this, 'KarpenterControllerRole', {
      roleName: `${cluster.clusterName}-karpenter`,
      path: "/",
      assumedBy: new iam.WebIdentityPrincipal(
        cluster.openIdConnectProvider.openIdConnectProviderArn,
        {
          // delay resolution to deployment-time to use tokens in object keys
          "StringEquals": new cdk.CfnJson(this, 'KarpenterControllerRoleStringEquals', { value: {
              [`${cluster.clusterOpenIdConnectIssuer}:aud`]: "sts.amazonaws.com",
              [`${cluster.clusterOpenIdConnectIssuer}:sub`]: "system:serviceaccount:karpenter:karpenter"
            }})
        }
      ),
      managedPolicies: [controllerPolicy]
    })
    controllerRole.node.addDependency(karpenterResourcesStack)

    const awsAuth = cluster.awsAuth
    cluster.awsAuth.node.addDependency(karpenterResourcesStack)

    awsAuth.addRoleMapping(nodeRole, {
      groups: ["system:bootstrappers", "system:nodes"],
      username: "system:node:{{EC2PrivateDNSName}}"
    })

    return cluster.addHelmChart('karpenter', {
      chart: 'karpenter',
      repository: 'oci://public.ecr.aws/karpenter/karpenter',
      version: karpenterVersion,
      namespace: 'karpenter',
      createNamespace: true,
      values: {
        serviceAccount: {
          name: 'karpenter', // added
          annotations: {
            "eks.amazonaws.com/role-arn": controllerRole.roleArn,
          }
        },
        settings: {
          aws: {
            clusterName: cluster.clusterName,
            defaultInstanceProfile: instanceProfileName,
            interruptionQueueName: interruptionQueueName
          }
        },
        controller: {
          resources: {
            requests: {
              cpu: 1,
              memory: "1Gi"
            },
            limits: {
              cpu: 1,
              memory: "1Gi"
            }
          }
        }
      },
      wait: true
    })
  }

  applyDefaultProvisionerAndNodeTemplateManifest(cluster: eks.Cluster) {
    return cluster.addManifest('DefaultProvisionerAndNodeTemplate',  {
      "apiVersion": "karpenter.k8s.aws/v1beta1",
      "kind": "EC2NodeClass",
      "metadata": {
        "name": "default"
      },
      "spec": {
        "amiFamily": "AL2",
        "role": `KarpenterNodeRole-${cluster.clusterName}`,
        "subnetSelectorTerms": [{
          "tags": {
            "Name": cluster.vpc.publicSubnets.join(",")
          }
        }],
        "securityGroupSelectorTerms": [{
          "id": cluster.clusterSecurityGroup.securityGroupId
        }],
      }
    }, {
      "apiVersion": "karpenter.sh/v1beta1",
      "kind": "NodePool",
      "metadata": {
        "name": "default"
      },
      "spec": {
        "template": {
          "spec": {
            "nodeClassRef": {
              "name": "default"
            },
            "requirements": [{
              "key": "karpenter.sh/capacity-type",
              "operator": "In",
              "values": ["spot"]
            }],
          }
        },
        "disruption": {
          "consolidationPolicy": "WhenUnderutilized"
        },
        "limits": {
          "cpu": "1000"
        }
      }
    })
  }

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = this.createVpc('karpenter-test')

    const cluster = this.createEKSCluster(vpc, 'karpenter-test')

    const karpenter = this.installKarpenter(cluster, 'v0.32.0')

    const defaultProvisionerAndNodeTemplate = this.applyDefaultProvisionerAndNodeTemplateManifest(cluster)
    defaultProvisionerAndNodeTemplate.node.addDependency(karpenter)
  }
}
