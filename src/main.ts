import '@gershy/clearing';
import phrasing                                       from '@gershy/util-phrasing';
import * as tf                                        from './util/terraform.ts';
import * as aws                                       from './util/aws.ts';
import { Garden, Flower, PetalTerraform } from '@gershy/lilac';
import type { AnyLambda, LambdaBase }                            from '@gershy/lilac-lambda';
// admin, write, query

class BinDbQuery { constructor(args: any) {} }
class BinDbWrite { constructor(args: any) {} }
class BinDbAdmin { constructor(args: any) {} }

export class BinDb extends Flower {
  
  protected region: string;
  protected name: string;
  protected bucket: null | PetalTerraform.Base;
  protected accessors: { mode: 'query' | 'write' | 'admin', baseKey: null | string, lambda: LambdaBase<any, any, any, any, any, any> }[];
  constructor(args: { garden?: Garden<any, any>, region: string, name: string }) {
    super(args);
    
    this.region = args.region ?? this.garden.defaults.region ?? null;
    if (!this.region) throw Error('region missing');
    
    this.name = args.name;
    this.bucket = null;
    this.accessors = [];
  }
  
  public * getDependencies() { yield* super.getDependencies(); }
  public getName() { return `${this.garden.pfx}-${phrasing('camel->kebab', this.name)}` }
  public getBucket() {
    if (!this.bucket)
      this.bucket = new PetalTerraform.Resource('awsS3Bucket', this.name, {
        bucket: this.getName(),
        forceDestroy: true // Make it easy to `terraform destroy`
      });
    
    return this.bucket;
  }
  
  public getAccessorConfig(baseKey: null | string) {
    return { bucket: this.getName(), baseKey };
  }
  
  addAccessor(mode: 'query', baseKey: null | string, lambda: AnyLambda): BinDbQuery;
  addAccessor(mode: 'write', baseKey: null | string, lambda: AnyLambda): BinDbWrite;
  addAccessor(mode: 'admin', baseKey: null | string, lambda: AnyLambda): BinDbAdmin;
  addAccessor(mode: 'query' | 'write' | 'admin', baseKey: null | string, lambda: LambdaBase<any, any, any, any, any, any>): any {
    
    this.accessors.push({ mode, baseKey, lambda });
    
    if (mode === 'admin') return new BinDbAdmin(this.getAccessorConfig(baseKey));
    if (mode === 'query') return new BinDbQuery(this.getAccessorConfig(baseKey));
    if (mode === 'write') return new BinDbWrite(this.getAccessorConfig(baseKey));
    
    throw Error('bad mode')[cl.mod]({ mode });
    
  }
  
  async computePetals() {
    
    const entities: PetalTerraform.Base[] = [];
    const addEntity = (petal: PetalTerraform.Base) => (entities.push(petal), petal);
    
    const bucket = addEntity(this.getBucket());
    
    const ownership = addEntity(new PetalTerraform.Resource('awsS3BucketOwnershipControls', this.name, {
      bucket: bucket.ref('bucket'),
      $rule: {
        objectOwnership: phrasing('camel->kamel', 'objectWriter')
      }
    }));
    
    addEntity(new PetalTerraform.Resource('awsS3BucketAcl', this.name, {
      bucket: bucket.ref('bucket'),
      acl: 'private',
      dependsOn: [ ownership.ref() ]
    }));
    
    for (const { mode, baseKey, lambda } of this.accessors) {
      
      const rolePetal = await lambda.getPetals().then(p => p.find(p => p.getType() === 'awsIamRole')!);
      const lambdaPolicyName = `lambdaStorage${phrasing('camel->kamel', lambda.getName())}${phrasing('camel->kamel', this.name)}`;
      const lambdaPolicy = addEntity(new PetalTerraform.Resource('awsIamPolicy', lambdaPolicyName, {
        name: `${this.garden.pfx}-${lambdaPolicyName}`,
        policy: tf.json(aws.capitalKeys({ version: '2012-10-17', statement: [{
          effect: phrasing('camel->kamel', 'allow'),
          action: [
            
            's3:ListBucket', // Always include this??
            ...([ 'query', 'admin' ][cl.has](mode) ? [ 's3:GetObject', ] : []),
            ...([ 'write', 'admin' ][cl.has](mode) ? [ 's3:PutObject', 's3:DeleteObject' ] : []),
            // ...([ 'keep' ][has](mode)         ? [] : [])
            
          ],
          resource: [
            `${tf.embed(bucket.ref('arn'))}`, // Consider: this is redundant unless using s3:ListObject, s3:GetBucketLocation, etc??
            `${tf.embed(bucket.ref('arn'))}/${baseKey ?? '*'}`,
          ]
        }]}))
      }));
      
      addEntity(new PetalTerraform.Resource('awsIamRolePolicyAttachment', lambdaPolicyName, {
        role:      rolePetal.ref('name'),
        policyArn: lambdaPolicy.ref('arn')
      }));
      
    }
    
    return entities;
    
  }
  
};