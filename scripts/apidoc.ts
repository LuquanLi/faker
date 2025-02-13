import { writeFileSync } from 'fs';
import { resolve } from 'path';
import type { Options } from 'prettier';
import { format } from 'prettier';
import sanitizeHtml from 'sanitize-html';
import * as TypeDoc from 'typedoc';
import { createMarkdownRenderer } from 'vitepress';
import prettierConfig from '../.prettierrc.cjs';
import type {
  Method,
  MethodParameter,
} from '../docs/.vitepress/components/api-docs/method';
import faker from '../src';
// TODO ST-DDT 2022-02-20: Actually import this/fix module import errors
// import vitepressConfig from '../docs/.vitepress/config';

const pathRoot = resolve(__dirname, '..');
const pathDocsDir = resolve(pathRoot, 'docs');
const pathDocsApiPages = resolve(pathDocsDir, '.vitepress', 'api-pages.mjs');
const pathOutputDir = resolve(pathDocsDir, 'api');
const pathOutputJson = resolve(pathOutputDir, 'typedoc.json');

const scriptCommand = 'pnpm run generate:api-docs';

const markdown = createMarkdownRenderer(
  pathOutputDir
  // TODO ST-DDT 2022-02-20: Actually import this/fix module import errors
  // vitepressConfig.markdown
);

const prettierMarkdown: Options = {
  ...prettierConfig,
  parser: 'markdown',
};

const prettierTypescript: Options = {
  ...prettierConfig,
  parser: 'typescript',
};

const prettierBabel: Options = {
  ...prettierConfig,
  parser: 'babel',
};

const htmlSanitizeOptions: sanitizeHtml.IOptions = {
  allowedTags: ['a', 'code', 'div', 'li', 'span', 'p', 'pre', 'ul'],
  allowedAttributes: {
    a: ['href', 'target', 'rel'],
    div: ['class'],
    pre: ['v-pre'],
    span: ['class'],
  },
  selfClosing: [],
};

export function prettifyMethodName(method: string): string {
  return (
    // Capitalize and insert space before upper case characters
    method.substring(0, 1).toUpperCase() +
    method.substring(1).replace(/([A-Z]+)/g, ' $1')
  );
}

function toBlock(comment?: TypeDoc.Comment): string {
  return (
    (comment?.shortText.trim() || 'Missing') +
    (comment?.text ? '\n\n' + comment.text : '')
  );
}

function mdToHtml(md: string): string {
  const rawHtml = markdown.render(md);
  const safeHtml: string = sanitizeHtml(rawHtml, htmlSanitizeOptions);
  // Revert some escaped characters for comparison.
  if (rawHtml.replace(/&gt;/g, '>') === safeHtml.replace(/&gt;/g, '>')) {
    return safeHtml;
  } else {
    console.debug('Rejected unsafe md:', md);
    console.error('Rejected unsafe html:', rawHtml.replace(/&gt;/g, '>'));
    console.error('Expected safe html:', safeHtml.replace(/&gt;/g, '>'));
    throw new Error('Found unsafe html');
  }
}

async function build(): Promise<void> {
  const app = new TypeDoc.Application();

  app.options.addReader(new TypeDoc.TSConfigReader());
  // If you want TypeDoc to load typedoc.json files
  //app.options.addReader(new TypeDoc.TypeDocReader());

  app.bootstrap({
    entryPoints: ['src/index.ts'],
    pretty: true,
    cleanOutputDir: true,
  });

  const project = app.convert();

  if (!project) {
    // Project may not have converted correctly
    return;
  }
  // Useful for analyzing the content
  await app.generateJson(project, pathOutputJson);

  const modules = project
    .getChildrenByKind(TypeDoc.ReflectionKind.Namespace)[0]
    .getChildrenByKind(TypeDoc.ReflectionKind.Class);

  const modulesPages: Array<{ text: string; link: string }> = [];
  modulesPages.push({ text: 'Fake', link: '/api/fake.html' });
  modulesPages.push({ text: 'Localization', link: '/api/localization.html' });

  // Generate module file
  for (const module of modules) {
    const moduleName = module.name.replace('_', '');
    const lowerModuleName =
      moduleName.substring(0, 1).toLowerCase() + moduleName.substring(1);
    if (faker[lowerModuleName] === undefined) {
      continue;
    }
    console.log(`Processing Module ${moduleName}`);

    modulesPages.push({
      text: moduleName,
      link: `/api/${lowerModuleName}.html`,
    });

    const methods: Method[] = [];

    // Generate method section
    for (const method of module.getChildrenByKind(
      TypeDoc.ReflectionKind.Method
    )) {
      const methodName = method.name;
      const prettyMethodName = prettifyMethodName(methodName);
      console.debug(`- method ${prettyMethodName}`);
      const signature = method.signatures[0];

      const parameters: MethodParameter[] = [];

      // Collect Type Parameters
      const typeParameters = signature.typeParameters || [];
      const signatureTypeParameters: string[] = [];
      for (const parameter of typeParameters) {
        signatureTypeParameters.push(parameter.name);
        parameters.push({
          name: parameter.name,
          description: mdToHtml(toBlock(parameter.comment)),
        });
      }

      // Collect Parameters
      const signatureParameters: string[] = [];
      let requiresArgs = false;
      for (
        let index = 0;
        signature.parameters && index < signature.parameters.length;
        index++
      ) {
        const parameter = signature.parameters[index];

        const parameterDefault = parameter.defaultValue;
        const parameterRequired = typeof parameterDefault === 'undefined';
        if (index === 0) {
          requiresArgs = parameterRequired;
        }
        const parameterName = parameter.name + (parameterRequired ? '?' : '');
        const parameterType = parameter.type.toString();

        let parameterDefaultSignatureText = '';
        if (!parameterRequired) {
          parameterDefaultSignatureText = ' = ' + parameterDefault;
        }

        signatureParameters.push(
          parameterName + ': ' + parameterType + parameterDefaultSignatureText
        );
        parameters.push({
          name: parameter.name,
          type: parameterType,
          default: parameterDefault,
          description: mdToHtml(toBlock(parameter.comment)),
        });
      }

      // Generate usage section

      let signatureTypeParametersString = '';
      if (signatureTypeParameters.length !== 0) {
        signatureTypeParametersString = `<${signatureTypeParameters.join(
          ', '
        )}>`;
      }
      const signatureParametersString = signatureParameters.join(', ');

      let examples = `faker.${lowerModuleName}.${methodName}${signatureTypeParametersString}(${signatureParametersString}): ${signature.type.toString()}\n`;
      faker.seed(0);
      if (!requiresArgs) {
        try {
          let example = JSON.stringify(faker[lowerModuleName][methodName]());
          if (example.length > 50) {
            example = example.substring(0, 47) + '...';
          }

          examples += `faker.${lowerModuleName}.${methodName}()`;
          examples += (example ? ` // => ${example}` : '') + '\n';
        } catch (error) {
          // Ignore the error => hide the example call + result.
        }
      }
      const exampleTags =
        signature?.comment?.tags
          .filter((tag) => tag.tagName === 'example')
          .map((tag) => tag.text.trimEnd()) || [];

      if (exampleTags.length > 0) {
        examples += exampleTags.join('\n').trim() + '\n';
      }

      const seeAlsos =
        signature.comment?.tags
          .filter((t) => t.tagName === 'see')
          .map((t) => t.text.trim()) ?? [];

      methods.push({
        name: methodName,
        title: prettyMethodName,
        description: mdToHtml(toBlock(signature.comment)),
        parameters: parameters,
        returns: signature.type.toString(),
        examples: mdToHtml('```ts\n' + examples + '```'),
        deprecated: signature.comment?.hasTag('deprecated') ?? false,
        seeAlsos,
      });
    }

    // Write api docs page
    let content = `
      <script setup>
      import ApiDocsMethod from '../.vitepress/components/api-docs/method.vue'
      import { ${lowerModuleName} } from './${lowerModuleName}'
      import { ref } from 'vue';

      const methods = ref(${lowerModuleName});
      </script>

      # ${moduleName}

      <!-- This file is automatically generated. -->
      <!-- Run '${scriptCommand}' to update -->

      ::: v-pre

      ${toBlock(module.comment)}

      :::

      <ApiDocsMethod v-for="method of methods" v-bind:key="method.name" :method="method" v-once />
      `.replace(/\n +/g, '\n');

    content = format(content, prettierMarkdown);

    writeFileSync(resolve(pathOutputDir, lowerModuleName + '.md'), content);

    // Write api docs data

    let contentTs = `
    import type { Method } from '../.vitepress/components/api-docs/method';

    export const ${lowerModuleName}: Method[] = ${JSON.stringify(
      methods,
      null,
      2
    )}`;

    contentTs = format(contentTs, prettierTypescript);

    writeFileSync(resolve(pathOutputDir, lowerModuleName + '.ts'), contentTs);
  }

  // Write api-pages.mjs
  console.log('Updating api-pages.mjs');
  modulesPages.sort((a, b) => a.text.localeCompare(b.text));
  let apiPagesContent = `
    // This file is automatically generated.
    // Run '${scriptCommand}' to update
    export const apiPages = ${JSON.stringify(modulesPages)};
    `.replace(/\n +/, '\n');

  apiPagesContent = format(apiPagesContent, prettierBabel);

  writeFileSync(pathDocsApiPages, apiPagesContent);
}

build().catch(console.error);
