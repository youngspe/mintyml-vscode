const yaml = require('js-yaml')
const fs = require('node:fs/promises')

const TM_SRC = './syntaxes/mintyml.tmLanguage.yaml'
const TM_DST = './syntaxes/mintyml.tmLanguage.json'
const LANG_CONFIG_SRC = './language-configuration.yaml'
const LANG_CONFIG_DST = './language-configuration.json'

/**
 * @typedef { { [k: string]: JsonValue } } JsonObject
 * @typedef { [JsonValue] } JsonArray
 * @typedef { string | number | boolean | null } JsonPrimitive
 * @typedef { JsonObject | JsonArray | JsonPrimitive } JsonValue
 */

async function convertTmlanguage() {
    /** @type { JsonObject } */
    const doc = yaml.load(await fs.readFile(TM_SRC, {
        encoding: 'utf8',
    }))

    /** @type {Record<string, string | null>} */
    const variables = {}

    /** @type {Record<string, boolean>} */
    const processed = {}

    /** @param { string } name @returns { string } */
    function getVariable(name) {
        let value = variables[name]
        if (value === null) throw new Error(`variable {{${name}}} circularly references itself`)
        if (value === undefined) {
            variables[name] = null
            if (!name in doc.variables) throw new Error(`unknown variable {{${name}}}`)
            value = variables[name] = expand(doc.variables[name])
        }
        return value
    }

    /** @param { string } src @returns { string }*/
    function expand(src) {
        return src.replace(/\{\{\s*(\w+)\s*\}\}/g, (_$0, $1) => getVariable($1))
    }

    const expandFields = ['match', 'begin', 'end', 'while']
    const captureFields = ['captures', 'beginCaptures', 'endCaptures', 'whileCaptures']

    /** @type { JsonObject[] } */
    const expandStack = Array.from(doc.patterns)

    /** @type { JsonObject | undefined } */
    let current

    while (current = expandStack.pop()) {
        for (const field of expandFields) {
            const value = current[field]
            if (typeof value === 'string') {
                current[field] = expand(value)
            }
        }
        if (current.patterns instanceof Array) {
            expandStack.push(...current.patterns)
        }

        for (const field of captureFields) {
            const value = current[field]
            if (value && typeof value === 'object') {
                expandStack.push(...Object.values(value))
            }
        }

        const include = current.include

        if (typeof include === 'string') {
            if (!include.startsWith('#')) throw new Error(`invalid include '${include}'`)
            const key = include.slice(1)
            if (!processed[key]) {
                processed[key] = true
                if (!(key in doc.repository)) throw new Error(`unknown include ${include}`)
                expandStack.push(doc.repository[key])
            }
        }
    }

    const variableDecls = doc.variables
    delete doc.variables

    const writePromise = fs.writeFile(TM_DST, JSON.stringify(doc, null, 2), {
        encoding: 'utf8',
    })

    for (const [key, _value] of Object.entries(doc.repository)) {
        if (!processed[key] && !key.startsWith('_')) {
            console.warn(`unused pattern #${key}`)
        }
    }

    for (const [key, _value] of Object.entries(variableDecls)) {
        if (!(key in variables) && !key.startsWith('_')) {
            console.warn(`unused variable {{${key}}}`)
        }
    }

    await writePromise
}

async function convertLanguageConfig() {
    /** @type { JsonObject } */
    const doc = yaml.load(await fs.readFile(LANG_CONFIG_SRC, {
        encoding: 'utf8',
    }))

    await fs.writeFile(LANG_CONFIG_DST, JSON.stringify(doc, null, 2))
}

convertTmlanguage()
convertLanguageConfig()
