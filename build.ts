import type { Document } from 'domhandler';
import { render as serializeHTML } from 'dom-serializer';
import { minify as minifyHTML } from 'html-minifier';
import { convertCSSToNonBlocking, convertJSToNonBlocking, getCSSImports, getConfig, getFilesMatching, getFilesRecursively, getHTML, getJSImports, replaceCSSImports, replaceJSImports, transpileCSS, transpileJS } from './src/index';
import path from 'node:path';
import { unlink, exists, mkdir, copyFile } from 'node:fs/promises';

let currentCompile: string | null = null;
const errorHandler = (e: any) => {
  if (e instanceof Error) {
    if (currentCompile) {
      console.error(`Error while compiling ${currentCompile}`);
    }
    console.error(e.message);
  } else {
    console.error(e);
  }
  process.exit(1);
};

const importMapper = (base: string, src: string) => {
  if (src.startsWith('/')) return src;
  return path.join(base, src);
}

const importDemapper = (base: string, src: string) => {
  return path.relative(base, src);
}

const config = await getConfig().catch(errorHandler);

const htmlFiles: string[] = await getFilesMatching(config.source, '**/*.html').catch(errorHandler);

const builtFiles: Record<string, string> = {};
// TODO: minify classes, config.html.minifyClasses
// const renamedClasses: Record<string, string> = {};

for (const htmlPath of htmlFiles) {
  currentCompile = htmlPath;
  const basePath = path.dirname(htmlPath);
  const html = await getHTML(htmlPath).catch(errorHandler);

  const cssImports = getCSSImports(html).map(src => importMapper(basePath, src));
  const jsImports = getJSImports(html).map(src => importMapper(basePath, src));

  for (const cssPath of cssImports) {
    currentCompile = cssPath;
    const builtPath = cssPath.replace(/\.(s[ac]|c)ss$/, '.css');
    if (!(builtPath in builtFiles)) {
      builtFiles[builtPath] = await transpileCSS(cssPath, { minify: config.css.minify }).catch(errorHandler);
    }
    replaceCSSImports(html, importDemapper(basePath, cssPath), importDemapper(basePath, builtPath));
  }

  for (const jsPath of jsImports) {
    currentCompile = jsPath;
    const builtPath = jsPath.replace(/\.tsx?$/, '.js');
    if (!(builtPath in builtFiles)) {
      builtFiles[builtPath] = await transpileJS(jsPath, { root: config.source, minify: config.css.minify }).catch(errorHandler);
    }
    replaceJSImports(html, importDemapper(basePath, jsPath), importDemapper(basePath, builtPath));
  }

  currentCompile = htmlPath;
  if (config.html.reduceBlocking) {
    convertCSSToNonBlocking(html);
    convertJSToNonBlocking(html);
  }

  builtFiles[htmlPath] = serializeHTML(html, { encodeEntities: true });
  if (config.html.minify) {
    builtFiles[htmlPath] = minifyHTML(builtFiles[htmlPath], {
      collapseBooleanAttributes: true,
      collapseInlineTagWhitespace: true,
      collapseWhitespace: true,
      continueOnParseError: true,
      html5: true,
      maxLineLength: Infinity,
      minifyCSS: true,
      minifyJS: true,
      minifyURLs: true,
      processConditionalComments: true,
      removeAttributeQuotes: true,
      removeComments: true,
      removeEmptyAttributes: true,
      removeScriptTypeAttributes: true,
      removeStyleLinkTypeAttributes: true,
      sortAttributes: true,
      sortClassName: true,
    });
  }
}

if (config.clean) {
  if (await exists(config.destination)) {
    const files = await getFilesRecursively(config.destination).catch(errorHandler);
    for (const file of files) {
      await unlink(file).catch(errorHandler);
    }
  } else {
    await mkdir(config.destination, { recursive: true }).catch(errorHandler);
  }
}


for (const [builtPath, content] of Object.entries(builtFiles)) {
  const destination = path.join(config.destination, path.relative(config.source, builtPath));
  await mkdir(path.dirname(destination), { recursive: true }).catch(errorHandler);
  await Bun.write(Bun.file(destination), content).catch(errorHandler);
}

for (const file of await getFilesRecursively(config.source)) {
  if (!path.extname(file).match(/\.(html|s[ac]ss|tsx?)$/)) {
    const destination = path.join(config.destination, path.relative(config.source, file));
    await mkdir(path.dirname(destination), { recursive: true }).catch(errorHandler);
    await copyFile(file, destination).catch(errorHandler);    
  }
}