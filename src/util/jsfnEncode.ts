export type JsImport = { varDef, importPath }; // Javascript-style import, so `varDef` can include simple variable assignment or destructuring; any content between `const ` and ` = ctx.jsfnImport(...)`!
export type SovereignFn = (...args: any) => any;
export type JsfnInst<Cls extends abstract new (...args: Jsfn[]) => any> = { toJsfn: () => JsfnInstSer<Cls> };
export type JsfnInstSer<Cls extends abstract new (...args: Jsfn[]) => any> = {
  hoist: `${string /* import url */}::${string /* exported class name */}`,
  form: Cls,
  args: ConstructorParameters<Cls>
};
export type Jsfn =
  | null
  | boolean
  | number
  | string
  | SovereignFn
  | JsfnInst<any>
  | Jsfn[]
  | { [K: string]: Jsfn };

export type JsfnEncodeArgs<V extends Jsfn> = { val: V, baseUrl: string };
export default <V extends Jsfn>(val: V) => {
  
  // const importReg = niceRegex(String[cl.baseline](`
  //   | ^[ ]*                                                                              (?:         )?
  //   |      const[ ]       [=][ ]*                     [.]jsfnImport[(]['#]        ['#][)]   [ ]+as[ ]  
  //   |              ([^=]+)       [a-zA-Z][a-zA-Z0-9.]*                    ([^'#]+)                     
  // `).replaceAll('#', '`'));
  
  // Captures lines like:
  // const util = ctx.jsfnImport('<repo>/src/boot/util');
  // const util = ctx.jsfnImport('<repo>/src/boot/util') as typeof import('../src/boot/util');
  // const { util1, util2 } = ctx.jsfnImport('<repo>/src/boot/util') as typeof import('../src/boot/util');
  // const { util1, util2 } = c.jsfnImport('<repo>/src/boot/util') as typeof import('../src/boot/util');
  const importReg = /^[ ]*const[ ]([^=]+)[=][ ]*[a-zA-Z][a-zA-Z0-9.]*[.]jsfnImport[(]["'`]([^"'`]+)["'`][)]/;
  
  const jsImports: JsImport[] = []; // Note "js imports" are a "reference to code, including a url, relative filepath, or name of an npm module"
  const serializeObjKey = (key: string) => /^[$_a-zA-Z][$_a-zA-Z]+$/.test(key) ? key : `'${key.replaceAll(`'`, `\\'`)}'`;
  const serialize = (val: Jsfn): string => {
    
    if (cl.isCls(val, Array))    return '[' + val.map      ((v   ) =>                          serialize(v))  .join(',') + ']';
    if (cl.isCls(val, Object))   return '{' + val[cl.toArr]((v, k) => `${serializeObjKey(k)}:${serialize(v)}`).join(',') + '}';
    
    if (cl.inCls(val, Function)) {
      
      const lines: string[] = [];
      
      for (const ln of val.toString().split('\n')) {
        const imp = ln.match(importReg);
        if (imp) jsImports.push({ varDef: imp[1], importPath: imp[2] }); // langHoist(varDef.trim(), resolveImport(importPath)) );
        else     lines.push(ln);
      }
      
      return lines.join('\n');
      
      // // Note Function.prototype.toString() produces a multiline result where the first line
      // // never has any indent, and all further lines are often quite deeply indented (depending
      // // on nesting in the source code) - we try to reindent these lines properly.
      // const leastIndent = Math.min(...lines.slice(1)[cl.map](ln => ln.match(/^[ ]*/)![0].length));
      // return lines.length > 1
      //   ? [ lines[0], ...lines.slice(1)[cl.map](ln => ln.slice(leastIndent)) ].join('\n')
      //   : lines[0];
      
    }
    
    if (cl.inCls((val as any)?.toJsfn, Function)) {
      const { args, form, hoist } = val as any as JsfnInstSer<any>;
      const [ importPath, clsName ] = hoist.split('::');
      jsImports.push({ varDef: clsName, importPath });
      return `new ${clsName}(${args.map(a => serialize(a as Jsfn)).join(',')})`;
    }
    
    return JSON.stringify(val);
    
  };
  
  // Note `code` is stringified, but it isn't json - it's js, in string representation!!
  return { jsImports, code: serialize(val) };

};