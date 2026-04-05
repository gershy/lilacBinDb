import applyClearing        from '@gershy/clearing';
import { Context, Flower }  from '@gershy/lilac';
import Logger               from '@gershy/logger';
import niceRegex            from '../util/niceRegex.ts';
import { Fact }             from '@gershy/disk';
import jsfnEncode, { Jsfn, JsImport } from '../util/jsfnEncode.ts';
import { Network } from '../other/network.ts';

// TODO:
// - Implement all bullshit types
// - Make sure this is reusable for lambda@edge tooooo

const Url = URL; type Url = URL;

// B.S. types (TODO: HEEERE!)
type Codec<I, O> = { parse: (val: I) => O };
type CodecOutput<Cdc> = Cdc extends Codec<any, infer O> ? O : never;
type Role = Flower;

// Real types

type SovereignFn = { (...args: any): any } | { new (...args: any): any };

type LambdaContext = Obj<unknown>;
type AwsLambdaContext = LambdaContext & {
  callbackWaitsForEmptyEventLoop: boolean,
  clientContext: unknown,
  invokedFunctionArn: string,
  awsRequestId: string,
  getRemainingTimeInMillis: () => number
};

type LambdaShape = {
  
  // Represents the raw provider Lambda typing, with req+res and any additional context
  
  ctx: Obj<unknown>,
  req: unknown,
  res: unknown
  
};
type AwsLambdaShape = LambdaShape & {
  
  ctx: {
    callbackWaitsForEmptyEventLoop: boolean,
    clientContext: unknown,
    invokedFunctionArn: string,
    awsRequestId: string,
    getRemainingTimeInMillis: () => number
  },
  req: {
    path: string,
    httpMethod: string,
    
    // Consider: no headers currently; they're all filtered out by cloudfront!
    headers: Obj,
    multiValueHeaders: Obj,
    
    queryStringParameters: any,
    multiValueQueryStringParameters: Obj<string[]>,
    requestContext: {
      
      // The properties always show up:
      identity: { sourceIp: `${number}.${number}.${number}.${number}` }, // Consider: typing is probably wrong for ipv6
      stage: string,
      domainName: string,
      
      // These show up for http connections:
      resourceId?: `${'GET' | 'POST' | 'PUT'} /${string}`,
      
      // These show up for socket connections:
      routeKey?:     '$connect' | '$disconnect' | string,
      eventType?:    'CONNECT' | 'DISCONNECT' | string, // Consider: I've only actually seen CONNECT so far...
      connectedAt?:  number,
      connectionId?: string,
      
      stageVariables: Obj<string>
      
    },
    body: any, // Consider testing how this value looks? And is it coupled with "isBase64Encoded"??
    isBase64Encoded: boolean,
  },
  res: {
    statusCode: number,
    headers: { [K: string]: string | string[] },
    isBase64Encoded?: boolean
    body: Json,
  }
  
};

type Stuff_TODO_RENAME_ME = {
  jsfnImport: (fp: string) => any,
  debug:      boolean,
  logger:     Logger,
};

export class MyLambda<
  Shape extends LambdaShape,   // AWS and lambda i/o
  LocalData extends Jsfn,      // Data provided to lambda by project
  SetupData,                   // Arbitrary data initialized by lambda on cold-start
  Cdc extends Codec<any, any>, // Codec for validating incoming invocation args
  Res extends Shape['res'],    // The lambda's particular response
  Env extends Obj<string>      // Environment vars (main use-case is for passing arbitrary infra values to lambda)
> extends Flower {
  
  static awsNodeRuntime = 'nodejs22.x'; // TODO: higher versions may require the terraform provider to be updated?? And decouple from aws
  static typescriptHoister = (v: null | string, p: string) => v ? `import ${v} from '${p}';` : `import '${p}';`;
  static javascriptHoister = (v: null | string, p: string) => {
    if (!v) return `require('${p}');`;
    
    // Referencing the default import requires the "default" property to be dereferenced; this is
    // detected by checking if the 1st character of `v` is a letter, whereas non-default imports
    // use object notation (beginning with "{")
    return /^[a-zA-Z]/.test(v)
      ? `const ${v} = require('${p}')['default'];`
      : `const ${v} = require('${p}');`
  };
  
  private memoryMb:  number;
  private network:   null | Network;
  private name:      string;
  private localData: (() => Promise<LocalData>) | Promise<LocalData> | (() => LocalData) | LocalData;
  private codec:     Cdc;
  private baseUrl:   string;
  private launchFn:  (ctx: { debug: boolean, logger: Logger, require: (fp: string) => any, data: LocalData }) => SetupData;
  private invokeFn:  (ctx: { debug: boolean, logger: Logger, require: (fp: string) => any, raw: Pick<Shape, 'ctx' | 'req'>, data: SetupData, args: CodecOutput<Cdc> }) => Res;
  private role:      Role;
  private env:       Env;
  
  constructor(args: {
    
    name:      string,
    memoryMb:  number,
    vpc?:      Network,
    localData: (() => Promise<LocalData>) | Promise<LocalData> | (() => LocalData) | LocalData;
    codec:     Cdc,
    baseUrl:   string,
    launchFn:  (ctx: { debug: boolean, logger: Logger, require: (fp: string) => any, data: LocalData }) => SetupData,
    invokeFn:  (ctx: { debug: boolean, logger: Logger, require: (fp: string) => any, raw: Pick<Shape, 'ctx' | 'req'>, data: SetupData, args: CodecOutput<Cdc> }) => Res,
    role:      Role,
    env:       Env
    
  }) {
    
    if (!/^[a-zA-Z0-9]+$/.test(args.name)) throw Error('invalid name')[cl.mod]({ args });
    
    const memoryMb = args.memoryMb ?? 2048;
    if (memoryMb < 128 || memoryMb > 10240 || Math.floor(memoryMb) != memoryMb) throw Error('memory mb invalid')[cl.mod]({ memoryMb });
    
    super();
    
    this.memoryMb  = memoryMb;
    this.network   = args.vpc ?? null;
    this.name      = args.name;
    this.localData = args.localData;
    this.codec     = args.codec;
    this.baseUrl   = args.baseUrl;
    this.launchFn  = args.launchFn;
    this.invokeFn  = args.invokeFn;
    this.role      = args.role;
    this.env       = args.env;
    
  }
  
  public getName() { return this.name; }
  public getRole() { return this.role; }
  
  public * getDependencies() {
    yield* super.getDependencies();
    yield* this.role.getDependencies();
    if (this.network) yield* this.network.getDependencies();
  }
  
  public async getLocalData() {
    
    // Resolves our local data, which may have been provided in a function
    if (cl.inCls(this.localData, Function)) this.localData = this.localData();
    return this.localData as LocalData | Promise<LocalData>;
    
  }
  
  protected getInvokeWrapper(): (args: Stuff_TODO_RENAME_ME & {
    
    codec:     Cdc,
    setupData: SetupData,
    shapeData: Pick<Shape, 'ctx' | 'req'>,
    invokeFn:  MyLambda<Shape, LocalData, SetupData, Cdc, Res, Env>['invokeFn']
    
  }) => Promise<Shape['res']> {
    
    // Returns a function which:
    // - Takes all data relevant to a single invocation, represented by `args`
    // - Calls `args.invokeFn` with the appropriate data
    // - Returns a correctly-shaped response
    
    throw Error('logic missing');
    
  }
  
  public async getSourceCode(args: { ctx: Context, npmFact: Fact, lang?: 'ts' | 'js' }) {
    
    // What are all possible places code can live? The space of urls. But sometimes code is
    // referred to by a pointer other than a url - the most common way is with a *relative path*; a
    // relative path is basically a url that requires context, and that context is: what is the
    // path relative to?? This question is answered by `(new Lambda(...)).baseUrl`, whose purpose
    // is to allow the meaningful conversion of relative paths to urls. Overall source code is
    // referenced by:
    // 1. A relative path - always begins with "."
    //    - `import './thing.ts'`
    //    - `import '../../thing.ts'`
    //    (relative path imports plust `baseUrl` can be resolved to a file:// url!)
    // 2. An npm import
    //    - `import 'zod'`
    //    - `import '@gershy/clearing'`
    // 3. A url (can't be confused with an npm import; disjoint based on presence of ":" character)
    //    - `import 'file:///C:/code/stuff.ts'`
    //    - `import 'https://scripts.org/cool-script.ts'`
    //    (Watch out for importing typescript in nodejs)
    
    // Converts this lambda's code (from multiple sources - launchFn, invokeFn, etc...) to a String
    // representing the entire aggregated lambda function definition, with imports to external
    // modules already embedded at the top of the code - can be used as sourcecode for webpack,
    // which will traverse any such imports.
    
    // Note the only use of typescript in the resulting lambda code at the moment is related to
    // imports (we get huge value leveraging typescript for imports because webpack's tree shaking
    // plus typescript `import` results in very minimal bundles!)
    // Compiling js vs ts is very simple; the logic to generate an import statement is the only
    // thing that varies depending on the language!
    
    const encodedData = jsfnEncode(await this.getLocalData());
    
    // Validate the vpc won't block access to any hoists!
    if (this.network) {
      
      const { jsImports } = encodedData;
      
      // TODO: This is very brittle - relies on the consumer using a particular naming scheme for
      // their js import variables - should at least convert to checking module names, i.e.
      // @gershy/lilac-bin-db, @gershy/lilac-doc-db, @gershy/lilac-email, @gershy/lilac-queue...
      // Consider: This is a "blacklist" approach - should really do a "whitelist" approach i.e.
      // every network boolean has a "permitsHoist" function, and every hoist needs to be permitted
      // by at least 1 boolean
      const vpcConfig = this.network.getConfig();
      const vpcInterferences = {
        binDb: { bool: vpcConfig.binDb, check: () => jsImports.filter(ji => /::LambdaStorage/.test(ji.varDef)) },
        docDb: { bool: vpcConfig.docDb, check: () => jsImports.filter(ji => /::LambdaDocDb/  .test(ji.varDef)) },
        email: { bool: vpcConfig.email, check: () => jsImports.filter(ji => /::LambdaEmail/  .test(ji.varDef)) },
        queue: { bool: vpcConfig.queue, check: () => jsImports.filter(ji => /::LambdaQueue/  .test(ji.varDef)) },
        w3:    { bool: vpcConfig.w3,    check: () => [ /* Impossible to verify for now... */ ]     },
      };
      
      for (const { bool, check } of vpcInterferences[cl.toArr](v => v)) {
        
        if (bool) continue;
        
        const blockedHoists = check();
        if (blockedHoists.length) throw Error('network hoist interference')[cl.mod]({ lambda: this.name, hoistsBlockedByVpc: blockedHoists });
        
      }
      
    }
    
    const jsfnEncodeResolveRelFp = <V extends Jsfn>(args: { val: V, baseUrl: string }): ReturnType<typeof jsfnEncode> => {
      
      // Simply calls `jsfnEncode`, and then resolves any relative-filepath-js-imports (using the
      // the provided `args.baseUrl`) to absolute filepaths
      
      const enc = jsfnEncode(args.val);
      
      return {
        ...enc,
        jsImports: enc.jsImports.map(ji => {
          
          if (ji.importPath[0] !== '.') return ji;
          return {
            ...ji,
            importPath: new Url(ji.importPath, args.baseUrl).href
          };
          
        })
      };
      
    };
    
    type InvokeWrapper = ReturnType<typeof this.getInvokeWrapper>;
    type LaunchFn =      typeof this.launchFn;
    type InvokeFn =      typeof this.invokeFn;
    type InvokeFullArgs = Stuff_TODO_RENAME_ME & {
      data: Pick<Shape, 'ctx' | 'req'>,
      invokeWrapper: InvokeWrapper,
      launchFn: LaunchFn,
      invokeFn: InvokeFn
    };
    const code: Obj<{ jsImports: JsImport[], code: string }> = {
      
      // TODO: HEEERE, jsfn does more work so everything is getting cleaner; consider:
      // - Allow `launchFn` and `invokeFn` to have separate baseUrls?
      // - Need to define classy serializable codecs...
      // - Need to make a string which begins with the merged imports, contains all `code.x.code`
      //   strings, wires them together, and defines/exports the lambda entrypoint...
      
      launchFn:      jsfnEncodeResolveRelFp({ baseUrl: this.baseUrl,    val: this.launchFn           }),
      invokeFn:      jsfnEncodeResolveRelFp({ baseUrl: this.baseUrl,    val: this.invokeFn           }),
      invokeWrapper: jsfnEncodeResolveRelFp({ baseUrl: import.meta.url, val: this.getInvokeWrapper() }),
      invoke:        jsfnEncodeResolveRelFp({ baseUrl: import.meta.url, val: (args: InvokeFullArgs) => {
        
        const applyClearing = args.jsfnImport('@gershy/clearing') as typeof import('@gershy/clearing')['default'];
        const Logger        = args.jsfnImport('@gershy/logger')   as typeof import('@gershy/logger')  ['default'];
        
        /*
        
        `const data = ${encodedData.code};`,
        
        // Init execution-context-wide logger...
        `const debug = ${ctx.debug ? 'true' : 'false'};`,
        `const lambdaLogger = new Logger('lambda');`,
        `lambdaLogger.log({ $$: 'launch', name: '${slashEscape(this.name, `'`)}' });`,
        
        // Logic functions
        `const begin = ${launchFnCode.code};`,
        `const checks = [${this.code.checks[map](c => c.toString()).join(', ')}];`,
        `const event = ${invokeFnCode.code};`,
        
        // Init supplies...
        `const supplies = lambdaLogger.scope('supplies', {}, logger => begin({ debug, require, logger, data }));`,
        
        // Note there is no "require" property - all code included here using "ctx.require"-type
        // functionality will have already been compiled to use hoists (`import`) instead!
        `const ctx = {  `,
        `  debug,       `,
        `  lambdaLogger,`,
        `  supplies,    `,
        `  checks,      `,
        `  event        `,
        `};             `,
        `const logic = (${executionWrapperCodeAndHoists.code}).bind(null, ctx);`,
        
        // Finally, export based on language
        {
          ts: 'export const handler = '   + `logic;`,
          js: 'module.exports.handler = ' + `logic;`
        }[lang]
        
        
        */
        
        
      }})
      
    };
    
    const mergeJsImports = (args: { jsImports: JsImport[], target: 'js' | 'ts' }) => {
      
      // TODO: HEEEERE!
      // Note merging fails if:
      // - The same variable name is used to reference values from different modules (no good name
      //   available for these global refs!)
      // 
      // Note some "apparent" failure cases can be accomodated:
      // - A module's default value is referenced in different places using inconsistent names;
      //   later occurrences can be assigned as aliases:
      //      | 
      //      | import name1 from 'module';
      //      | const name2 = name1;
      //      | 
      
      const langHoist = {
        ts: MyLambda.typescriptHoister,
        js: MyLambda.javascriptHoister
      }[args.lang ?? 'ts'];
      
      
      return [ 'a', 'b' ];
      
    };
    const mergedJsImports = mergeJsImports({
      jsImports: code[cl.toArr](v => v.jsImports).flat(1),
      target: 'ts'
    });
    
    return [
      // Import all hoists...
      ...hoists,
      
      // Sooooo *all* hoisted references are provided to *every* jsfn eval - will crash if multiple
      // hoists use the same reference name but from different imports. And there's no hoist
      // merging: `import { a, b } from 'z'; import { a, c } from 'z';` will fail due to `a` being
      // redefined. Need more structure around the import, something like:
      //    | 
      //    | type Import = never
      ///   |   | { type: 'trivial' }                                         // require('thingy');                     import 'thingy';
      ///   |   | { type: 'default' }                                         // const thing = require('thingy');       import z from 'thingy';
      //    |   | { type: 'select', props: { name: string, alias?: string } } // const { a, b: c } = require('thingy'); import { a, b as c } from 'thingy';
      //    |
      // and full logic to actually handle merging hoists. Also, hoisting should probably be native
      // jsfn functionality??
      
      // Data
      `const data = ${encodedData.code};`,
      
      // Init execution-context-wide logger...
      `const debug = ${ctx.debug ? 'true' : 'false'};`,
      `const lambdaLogger = new Logger('lambda');`,
      `lambdaLogger.log({ $$: 'launch', name: '${slashEscape(this.name, `'`)}' });`,
      
      // Logic functions
      `const begin = ${launchFnCode.code};`,
      `const checks = [${this.code.checks[map](c => c.toString()).join(', ')}];`,
      `const event = ${invokeFnCode.code};`,
      
      // Init supplies...
      `const supplies = lambdaLogger.scope('supplies', {}, logger => begin({ debug, require, logger, data }));`,
      
      // Note there is no "require" property - all code included here using "ctx.require"-type
      // functionality will have already been compiled to use hoists (`import`) instead!
      `const ctx = {  `,
      `  debug,       `,
      `  lambdaLogger,`,
      `  supplies,    `,
      `  checks,      `,
      `  event        `,
      `};             `,
      `const logic = (${executionWrapperCodeAndHoists.code}).bind(null, ctx);`,
      
      // Finally, export based on language
      {
        ts: 'export const handler = '   + `logic;`,
        js: 'module.exports.handler = ' + `logic;`
      }[lang]
      
    ][map](ln => ln.trimEnd() ?? skip).join('\n');
    
  }
  
}
