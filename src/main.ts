import '@gershy/clearing';
import { Context, Flower, PetalTerraform } from '@gershy/lilac';

// admin, write, query

export class Storage extends Flower {
  
  protected name: string;
  protected bucket: null | PetalTerraform.Base;
  protected accessors: { mode: 'view' | 'mark' | 'keep', baseKey: null | string, lambda: Lambda<any, any, any, any, any> }[];
  constructor(args: { name: string }) {
    super();
    this.name = args.name;
    this.bucket = null;
    this.accessors = [];
  }
  
  public * getDependencies() { yield* super.getDependencies(); }
  public getName(ctx) { return `${ctx.pfx}-${phrasing('camel->kebab', this.name)}` }
  public getBucket(ctx: Context) {
    if (!this.bucket)
      this.bucket = new PetalTerraform.Resource('awsS3Bucket', this.name, {
        bucket: this.getName(ctx),
        tags: {
          system: ctx.name,
          maturity: ctx.maturity
        },
        forceDestroy: true // Make it easy to `terraform destroy`
      });
    
    return this.bucket;
  }
  
  public getAccessorConfig(ctx: Context, baseKey: null | string) {
    return { bucket: this.getName(ctx), baseKey };
  }
  
  addAccessor(ctx: Context, mode: 'view', baseKey: null | string, lambda: Lambda<any, any, any, any, any>): JsfnInst<typeof LambdaStorageViewer>;
  addAccessor(ctx: Context, mode: 'mark', baseKey: null | string, lambda: Lambda<any, any, any, any, any>): JsfnInst<typeof LambdaStorageMarker>;
  addAccessor(ctx: Context, mode: 'keep', baseKey: null | string, lambda: Lambda<any, any, any, any, any>): JsfnInst<typeof LambdaStorageKeeper>;
  addAccessor(ctx: Context, mode: 'view' | 'mark' | 'keep', baseKey: null | string, lambda: Lambda<any, any, any, any, any>): any {
    
    this.accessors.push({ mode, baseKey, lambda });
    
    if (mode === 'keep') {
      
      return {
        hoist: '<repo>/src/node/lilac/comm/lambdaStorage/keep::LambdaStorageKeeper',
        form: LambdaStorageKeeper,
        args: [ this.getAccessorConfig(ctx, baseKey) ]
      } as JsfnInst<typeof LambdaStorageKeeper>;
      
    } else if (mode === 'view') {
      
      return {
        hoist: '<repo>/src/node/lilac/comm/lambdaStorage/view::LambdaStorageViewer',
        form: LambdaStorageViewer,
        args: [ this.getAccessorConfig(ctx, baseKey) ]
      } as JsfnInst<typeof LambdaStorageViewer>;
      
    } else if (mode === 'mark') {
      
      return {
        hoist: '<repo>/src/node/lilac/comm/lambdaStorage/mark::LambdaStorageMarker',
        form: LambdaStorageMarker,
        args: [ this.getAccessorConfig(ctx, baseKey) ]
      } as JsfnInst<typeof LambdaStorageMarker>;
      
    }
    
    throw Error('bad mode')[mod]({ mode });
    
  }
  
  async getTfEntities0(ctx: LilacContext) {
    
    const entities: TfEntity[] = [];
    const addEntity = (ent: TfEntity) => { entities.push(ent); return ent; };
    
    const bucket = addEntity(this.getBucket(ctx));
    
    const ownership = addEntity(new TfResource('awsS3BucketOwnershipControls', this.name, {
      bucket: bucket.tfRefp('bucket'),
      $rule: {
        objectOwnership: capitalize('objectWriter')
      }
    }));
    
    const accessControlList = addEntity(new TfResource('awsS3BucketAcl', this.name, {
      bucket: bucket.tfRefp('bucket'),
      acl: 'private',
      dependsOn: [ ownership.tfRefp() ]
    }));
    
    for (const { mode, baseKey, lambda } of this.accessors) {
      
      const roleTfEnt = await lambda.getRole().getTfEntities(ctx).then(ents => ents.find(ent => ent.getType() === 'awsIamRole')!);
      
      const lambdaPolicyName = capitalize([ 'lambdaStorage', lambda.getName(), this.name ]);
      const lambdaPolicy = addEntity(new TfResource('awsIamPolicy', lambdaPolicyName, {
        name: `${ctx.pfx}-${lambdaPolicyName}`,
        policy: tf.json(aws.capitalKeys({ version: '2012-10-17', statement: [{
          effect: capitalize('allow'),
          action: [
            
            's3:ListBucket', // Always include this??
            ...([ 'view', 'keep' ][has](mode) ? [ 's3:GetObject', ] : []),
            ...([ 'mark', 'keep' ][has](mode) ? [ 's3:PutObject', 's3:DeleteObject' ] : []),
            // ...([ 'keep' ][has](mode)         ? [] : [])
            
          ],
          resource: [
            `${tf.embed(bucket.tfRef('arn'))}`, // Consider: this is redundant unless using s3:ListObject, s3:GetBucketLocation, etc??
            `${tf.embed(bucket.tfRef('arn'))}/${baseKey ?? '*'}`,
          ]
        }]}))
      }));
      
      const lambdaPolicyAttachment = addEntity(new TfResource('awsIamRolePolicyAttachment', lambdaPolicyName, {
        role:      roleTfEnt.tfRefp('name'),
        policyArn: lambdaPolicy.tfRefp('arn')
      }));
      
    }
    
    return entities;
    
  }
  
};