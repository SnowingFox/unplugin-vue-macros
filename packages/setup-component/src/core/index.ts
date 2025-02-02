import {
  DEFINE_SETUP_COMPONENT,
  MagicString,
  babelParse,
  getLang,
  getTransformResult,
  isCallOf,
  walkAST,
} from '@vue-macros/common'
import { normalizePath } from '@rollup/pluginutils'
import {
  SETUP_COMPONENT_ID_REGEX,
  SETUP_COMPONENT_ID_SUFFIX,
  SETUP_COMPONENT_TYPE,
} from './constants'
import { isSubModule } from './sub-module'
import type {
  Function,
  Node,
  Program,
  VariableDeclaration,
  VariableDeclarator,
} from '@babel/types'
import type { HmrContext, ModuleNode } from 'vite'

export * from './constants'

// TODO SWC

interface FileContextComponent {
  code: string
  body: string
  node: Node
}

interface FileContext {
  components: FileContextComponent[]
  imports: string[]
  declartions: Declartions
}

type Declartions = string[]

export type SetupComponentContext = Record<string, FileContext>

const isFCType = (val: unknown): val is VariableDeclarator => {
  const node = val as Node

  if (!node) return false

  return !!(
    node.type === 'VariableDeclarator' &&
    node.id.type === 'Identifier' &&
    node.id.typeAnnotation?.type === 'TSTypeAnnotation' &&
    node.id.typeAnnotation.typeAnnotation.type === 'TSTypeReference' &&
    node.id.typeAnnotation.typeAnnotation.typeName.type === 'Identifier' &&
    node.id.typeAnnotation.typeAnnotation.typeName.name ===
      SETUP_COMPONENT_TYPE &&
    node.init
  )
}

const validIds = new Set()

export const scanSetupComponent = (
  code: string,
  id: string
): FileContext | undefined => {
  let program: Program

  try {
    program = babelParse(code, getLang(id))
  } catch {
    return undefined
  }

  const components: {
    /** defineSetupComponent(...) */
    fn?: Node
    /** component decl */
    decl: Node
  }[] = []
  const imports: FileContext['imports'] = []
  const declartions: Declartions = []

  walkAST<Node>(program, {
    enter(node) {
      // defineSetupComponent(...)
      if (isCallOf(node, DEFINE_SETUP_COMPONENT)) {
        components.push({
          fn: node,
          decl: node.arguments[0],
        })
        validIds.add(id)
      } else if (isFCType(node)) {
        // const comp: SetupFC = ...
        components.push({
          decl: node.init!,
        })
        validIds.add(id)
      } else if (node.type === 'ImportDeclaration') {
        imports.push(code.slice(node.start!, node.end!))
      }
    },
  })

  if (validIds.has(id)) {
    for (const body of program.body) {
      if (
        body.type !== 'ImportDeclaration' &&
        !body.type.includes('Export') &&
        !isFCType((body as VariableDeclaration)?.declarations?.[0]) &&
        !isCallOf(body, DEFINE_SETUP_COMPONENT) &&
        !(body.type === 'ExpressionStatement' && isCallOf(body.expression, 'h'))
      ) {
        declartions.push(code.slice(body.start!, body.end!))
      }
    }
  }

  const ctxComponents = components.map(({ decl, fn }): FileContextComponent => {
    if (!['FunctionExpression', 'ArrowFunctionExpression'].includes(decl.type))
      throw new SyntaxError(
        `${DEFINE_SETUP_COMPONENT}: invalid setup component definition`
      )

    const body = (decl as Function)?.body
    let bodyStart = body.start!
    let bodyEnd = body.end!
    if (body.type === 'BlockStatement') {
      bodyStart++
      bodyEnd--
    }

    return {
      code: code.slice(decl.start!, decl.end!),
      body: code.slice(bodyStart, bodyEnd),
      node: fn || decl,
    }
  })

  return {
    components: ctxComponents,
    imports,
    declartions,
  }
}

export const transformSetupComponent = (
  code: string,
  id: string,
  ctx: SetupComponentContext
) => {
  const normalizedId = normalizePath(id)
  const s = new MagicString(code)

  const fileContext = scanSetupComponent(code, id)
  if (!fileContext) return
  ctx[normalizedId] = fileContext

  for (const [i, { node }] of fileContext.components.entries()) {
    const importName = `setupComponent_${i}`

    s.overwrite(node.start!, node.end!, importName)

    s.prepend(
      `import ${importName} from '${normalizedId}${SETUP_COMPONENT_ID_SUFFIX}${i}.vue'\n`
    )
  }

  return getTransformResult(s, id)
}

export const loadSetupComponent = (
  virtualId: string,
  ctx: SetupComponentContext,
  root: string
) => {
  const index = +(SETUP_COMPONENT_ID_REGEX.exec(virtualId)?.[1] ?? -1)
  const id = virtualId.replace(SETUP_COMPONENT_ID_REGEX, '')
  const { components, imports, declartions } = ctx[id] || ctx[root + id] || {}
  const component = components[index]
  if (!component) return

  const { body } = component
  const lang = getLang(id)

  const s = new MagicString(body)
  const program = babelParse(body, lang, {
    allowReturnOutsideFunction: true,
    allowImportExportEverywhere: true,
  })
  for (const stmt of program.body) {
    // transform return
    if (stmt.type !== 'ReturnStatement' || !stmt.argument) continue
    s.overwriteNode(stmt, `defineRender(${s.sliceNode(stmt.argument)});`)
  }

  for (const i of imports) s.prepend(`${i}\n`)
  s.prepend(`<script setup${lang ? ` lang="${lang}"` : ''}>`)
  s.append(`</script>`)

  // resolve declartions which is not valid component.
  if (declartions?.length) {
    const declBody = new MagicString('')

    declBody.prepend(`<script${lang ? ` lang="${lang}"` : ''}>`)
    for (const i of declartions) declBody.append(`${i}\n`)
    declBody.append(`</script>`)
    s.prepend(declBody.toString())
  }

  return s.toString()
}

export const hotUpdateSetupComponent = async (
  { file, modules, read }: HmrContext,
  ctx: SetupComponentContext
) => {
  const getSubModule = (module: ModuleNode): ModuleNode[] => {
    const importedModules = Array.from(module.importedModules)
    if (importedModules.length === 0) return []

    return importedModules
      .filter(({ id }) => id && isSubModule(id!))
      .flatMap((module) => [module, ...getSubModule(module)])
  }

  const module = modules.find((mod) => mod.file === file)
  if (!module?.id) return

  const affectedModules = getSubModule(module)

  const normalizedId = normalizePath(file)
  const nodeContexts = scanSetupComponent(await read(), normalizedId)
  if (nodeContexts) ctx[normalizedId] = nodeContexts

  return [...modules, ...affectedModules]
}
