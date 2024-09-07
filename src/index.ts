import type { BunFile } from 'bun';
import { Element, type Document } from 'domhandler';
import { DomUtils, parseDocument } from 'htmlparser2';
import micromatch from 'micromatch';
import { readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { initAsyncCompiler } from 'sass';
import ts from 'typescript';
import { minify as minifyJS } from 'uglify-js';

export interface BSTConfig {
  source: string;
  destination: string;
  clean: boolean;
  css: {
    minify: boolean;
  };
  html: {
    minify: boolean;
    minifyClasses: boolean;
    reduceBlocking: boolean;
  };
  js: {
    minify: boolean;
  };
}

export type PartialRecursive<T> = {
  [P in keyof T]?: PartialRecursive<T[P]>;
};

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

async function isDir(pathname: string): Promise<boolean> {
  try {
    return (await lstat(pathname)).isDirectory();
  } catch {
    return false;
  }
}

async function pickFirstExisting(...files: BunFile[]): Promise<BunFile | null> {
  console.log(files.map(file => file.name));
  for (const file of files) {
    if (await file.exists()) {
      return file;
    }
  }
  return null;
}

export async function getFilesMatching(pathname: string, glob: string | string[]): Promise<string[]> {
  const files = micromatch.match(await getFilesRecursively(pathname), glob);
  return files.map(file => path.join(pathname, path.relative(pathname, file)));
}

export async function getFilesRecursively(dir: string): Promise<string[]> {
  const files = [];
  const entries = await readdir(dir);
  
  for (const entry of entries) {
    const entryPath = path.join(dir, entry);
    const entryStat = await lstat(entryPath);
    
    if (entryStat.isDirectory()) {
      const subFiles = await getFilesRecursively(entryPath);
      files.push(...subFiles);
    } else {
      files.push(entryPath);
    }
  }
  
  return files;
}

export async function getConfig(): Promise<BSTConfig> {
  const file = Bun.file('bst.json');
  if (!await file.exists()) {
    throw new Error('bst.json not found');
  }
  
  const importedConfig: PartialRecursive<BSTConfig> = await file.json();
  
  if (!importedConfig.source || !importedConfig.destination) {
    throw new Error('bst.json must have source and destination fields');
  }
  
  const config: BSTConfig = {
    source: importedConfig.source,
    destination: importedConfig.destination,
    clean: importedConfig.clean ?? false,
    css: {
      minify: importedConfig.css?.minify ?? true,
    },
    html: {
      minify: importedConfig.html?.minify ?? true,
      minifyClasses: importedConfig.html?.minifyClasses ?? true,
      reduceBlocking: importedConfig.html?.reduceBlocking ?? true,
    },
    js: {
      minify: importedConfig.js?.minify ?? true,
    },
  };
  
  return config as BSTConfig;
}

export async function getHTML(pathname: string): Promise<Document> {
  const file = Bun.file(pathname);
  if (!await file.exists()) {
    throw new Error(`${pathname} not found`);
  }
  const html = await file.text();
  const doc = parseDocument(html);
  
  // Normalize class attributes
  for (const node of DomUtils.findAll(node => DomUtils.hasAttrib(node, 'class'), doc.children)) {
    const classes = node.attribs.class.split(' ');
    const uniqueClasses = uniq(classes);
    node.attribs.class = uniqueClasses.join(' ');
  }
  
  return doc;
}

function getCSSElements(document: Document): Element[] {
  return DomUtils.findAll(
    node =>
      node.name === 'link' &&
    node.attribs.rel === 'stylesheet',
    document.children
  );
}

export function getCSSImports(document: Document): string[] {
  return getCSSElements(document)
  .map(node => node.attribs.href)
  .map(pathname => path.normalize(pathname));
}

export function replaceCSSImports(document: Document, original: string, replaced: string): void {
  const elements = getCSSElements(document);
  for (const element of elements) {
    if (element.attribs.href === original) {
      element.attribs.href = replaced;
    }
  }
}

export function convertCSSToNonBlocking(document: Document): void {
  const elements = getCSSElements(document);
  for (const element of elements) {
    const preload = new Element('link', {
      rel: 'preload',
      href: element.attribs.href,
      as: 'style',
      onload: 'this.onload=null;this.rel=`stylesheet`', // Single and double quotes are HTML-escaped, so we use backticks
    });
    const noscript = new Element('noscript', {}, [
      new Element('link', {
        rel: 'stylesheet',
        href: element.attribs.href,
      }),
    ]);
    DomUtils.append(element, preload);
    DomUtils.append(element, noscript);
    DomUtils.removeElement(element);
  }
}

// This actually changes functionality, so it's not a good idea
// export function convertJSToNonBlocking(document: Document): void {
//   const elements = getJSElements(document);
//   for (const element of elements) {
//     element.attribs.async = '';
//   }
// }

export function getJSElements(document: Document): Element[] {
  return DomUtils.findAll(
    node => node.tagName === 'script' && DomUtils.hasAttrib(node, 'src'),
    document.children
  );
}

export function getJSImports(document: Document): string[] {
  return getJSElements(document)
  .map(node => node.attributes.find(attr => attr.name === 'src')!.value)
  .map(pathname => path.normalize(pathname));
}

export function replaceJSImports(document: Document, original: string, replaced: string): void {
  const elements = getJSElements(document);
  for (const element of elements) {
    if (element.attribs.src === original) {
      element.attribs.src = replaced;
    }
  }
}

export function getAllClassNames(document: Document): string[] {
  return DomUtils.findAll(
    node => DomUtils.hasAttrib(node, 'class'),
    document.children
  )
  .map(node => node.attribs.class.split(' ')).flat()
  .map(pathname => path.normalize(pathname));;
}

export function replaceClassName(document: Document, original: string, replaced: string): void {
  const classedNodes = DomUtils.findAll(
    node => DomUtils.hasAttrib(node, 'class'),
    document.children
  );
  
  for (const node of classedNodes) {
    const classNames = node.attribs.class.split(' ');
    const index = classNames.indexOf(original);
    if (index !== -1) {
      classNames[index] = replaced;
      node.attribs.class = classNames.join(' ');
    }
  }
}

const sassCompiler = await initAsyncCompiler();
const transpileCache = new Map<string, string>();
export async function transpileCSS(pathname: string, options: { minify: boolean }): Promise<string> {
  if (transpileCache.has(pathname)) {
    return transpileCache.get(pathname)!;
  }
  const file = Bun.file(pathname);
  if (!await file.exists()) {
    throw new Error(`${pathname} not found`);
  }
  const sass = await file.text();
  return (await sassCompiler.compileStringAsync(sass, {
    importer: {
      canonicalize(url, context) {
        if (url.includes('/~/')) {
          url = url.slice(url.indexOf('/~/') + 1);
        }

        if (url.startsWith('~/')) {
          return new URL(url.slice(2), 'file:///node_modules/');
        } else {
          return new URL(url, context.containingUrl ?? new URL(pathname, 'file:///'));
        }
      },
      async load(canonicalUrl) {
        const canonPath = canonicalUrl.pathname.slice(1);
        const file = await pickFirstExisting(
          Bun.file(canonPath),
          Bun.file(
            (await isDir(canonPath)) ?
              path.join(canonPath, '_index.scss') :
              path.join(path.dirname(canonPath), '_' + path.basename(canonPath))
          )
        );
        if (file === null) {
          throw new Error(`${canonPath} not found`);
        }
        return {
          contents: await file.text(),
          syntax: 'scss',
        };
      },
    },
    style: options.minify ? 'compressed' : 'expanded', 
  })).css;
}

export async function transpileJS(pathname: string, options: { root: string; minify: boolean }): Promise<string> {
  const file = Bun.file(pathname);
  if (!await file.exists()) {
    throw new Error(`${pathname} not found`);
  }
  
  const output = await Bun.build({
    entrypoints: [ pathname ],
    root: options.root,
    format: 'esm',
    minify: options.minify,
    sourcemap: 'none',
    target: 'browser',
  });
  
  if (!output.success) {
    for (const log of output.logs) {
      if (log.level === 'error') {
        console.error(log.message);
      } else {
        console.log(log.message);
      }
    }
    
    throw new Error(`Failed to transpile: ${pathname}`);
  }
  
  if (output.outputs.length !== 1) {
    throw new Error(`Expected one output while transpiling, got ${output.outputs.length}`);
  }
  
  if (output.outputs[0].kind !== 'entry-point') {
    throw new Error(`Expected output to be an entry-point, got ${output.outputs[0].kind}`);
  }
  
  const transformed = removeExportsFromJS(await output.outputs[0].text(), { minify: options.minify });

  return options.minify ? minifyJS(transformed, {
    output: {
      max_line_len: Infinity,
    },
    toplevel: true,
  }).code : transformed;
}

function removeExportsFromJS(sourceText: string, options: { minify: boolean }): string {
  const source = ts.createSourceFile("", sourceText, ts.ScriptTarget.ESNext);
  
  const transformer = (context: ts.TransformationContext) => {
    const visit: ts.Visitor<ts.Node, ts.Node> = (node: ts.Node) => {
      if (ts.isSourceFile(node)) {
        const updatedStatements = node.statements.filter(stmt => !ts.isExportDeclaration(stmt));
        return ts.factory.updateSourceFile(node, updatedStatements);
      } else if (ts.isBlock(node)) {
        const updatedStatements = node.statements.filter(stmt => !ts.isExportDeclaration(stmt));
        return ts.factory.updateBlock(node, updatedStatements);
      } else if (ts.isModuleBlock(node)) {
        const updatedStatements = node.statements.filter(stmt => !ts.isExportDeclaration(stmt));
        return ts.factory.updateModuleBlock(node, updatedStatements);
      }
      return ts.visitEachChild(node, visit, context);
    };
    
    return (node: ts.Node) => ts.visitNode(node, visit);
  };
  
  const result = ts.transform(source, [transformer]);

  const printer = ts.createPrinter({
    newLine: ts.NewLineKind.LineFeed,
    omitTrailingSemicolon: options.minify,
    removeComments: options.minify,
  });
  const updatedSourceText = printer.printFile(result.transformed[0] as ts.SourceFile);

  return updatedSourceText;
}
