/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable @typescript-eslint/no-unsafe-call */

// Import the yaml library, installed from npm
import * as yaml from "js-yaml"
import { Graph, alg } from "graphlib"

// Import the fs library, built into node.js's standard library
import fs from "fs"

type AstModel = unknown[] | Record<string, unknown> | string

type Ast = {
    config: { [key: string]: unknown }
    models: { [key: string]: AstModel }
}

enum JsType {
    Null,
    Array,
    Object,
    Boolean,
    String,
    BigInt,
    Symbol,
    Undefined,
    Number
}

interface ITypeSpec {
    isArray: boolean
    isOptional: boolean
    isBoxed: boolean
    isSized: boolean
}

class TypeSpec implements ITypeSpec {
    type: string | TypeSpec | null
    isArray: boolean
    isOptional: boolean
    isBoxed: boolean
    isSized: boolean

    constructor(type: string | TypeSpec | null, isArray = false, isOptional = false) {
        this.isArray = isArray
        this.isOptional = isOptional
        this.type = type

        this.isBoxed = false
        this.isSized = true
    }
}

class StructSpec {
    name: string
    fields: { [name: string]: TypeSpec }

    constructor(name: string, fields: { [name: string]: TypeSpec }) {
        this.name = name
        this.fields = fields
    }
}

class TupleStructSpec {
    name: string
    operands: TypeSpec[]

    constructor(name: string, operands: TypeSpec[]) {
        this.name = name
        this.operands = operands
    }

    isArray(): boolean {
        return this.operands.length === 1 && this.operands[0].isArray
    }
}

class EnumSpec {
    name: string
    cases: { [name: string]: CaseSpec }

    constructor(name: string, cases: { [name: string]: CaseSpec }) {
        this.name = name
        this.cases = cases
    }
}

class CaseSpec {
    operands: TypeSpec[]

    constructor(operands: TypeSpec[]) {
        this.operands = operands
    }
}

function typeOf(value: unknown): JsType {
    if (value === null) {
        return JsType.Null
    }

    if (Array.isArray(value)) {
        return JsType.Array
    }

    switch (typeof value) {
        case "object":
            return JsType.Object
        case "boolean":
            return JsType.Boolean
        case "string":
            return JsType.String
        case "number":
            return JsType.Number
        case "undefined":
            return JsType.Undefined
        case "symbol":
            return JsType.Symbol
        case "bigint":
            return JsType.BigInt
        default:
            throw new Error(`Unknown type from typeof: ${typeof value}`)
    }
}

type TopLevelSpec = TupleStructSpec | EnumSpec | StructSpec
type Paths = {
    [x: string]: {
        [x: string]: PathSpec[]
    }
}

type PathSpec = {
    enumName: string;
    enumCase: string;
    typeName: string;
    typeSpec: TypeSpec
}

function alphabet(count: number) {
    const o = []
    for (let i = 97; i < 97 + count; ++i) {
        o.push(String.fromCharCode(i))
    }
    return o
}

class RustGenerator {
    private readonly derive: string[]
    private readonly visibility?: string
    private readonly models: TopLevelSpec[]
    private readonly paths: Paths

    constructor(config: { [key: string]: unknown }, models: TopLevelSpec[]) {
        if (isStringArray(config.derive)) {
            this.derive = config.derive
        } else {
            this.derive = []
        }

        if (isString(config.visibility)) {
            this.visibility = config.visibility
        }

        this.models = models
        this.paths = this.derivePaths()
    }

    private resolveType(spec: string | TypeSpec | null, ignoreWrappers = false): string {
        if (spec == null) {
            return "()"
        }

        if (typeof spec === "string") {
            return spec
        }

        if (!ignoreWrappers) {
            if (spec.isOptional) {
                if (spec.isArray) {
                    return `Option<Box<[${this.resolveType(spec.type)}]>>`
                }

                if (spec.isBoxed) {
                    return `Option<Box<${this.resolveType(spec.type)}>>`
                }

                return `Option<${this.resolveType(spec.type)}>`
            }

            if (spec.isArray) {
                return `Box<[${this.resolveType(spec.type)}]>`
            } else if (spec.isBoxed) {
                return `Box<${this.resolveType(spec.type)}>`
            }
        }

        return this.resolveType(spec.type)
    }

    private generateTupleStruct(model: TupleStructSpec) {
        const vis = this.visibility ? `${this.visibility} ` : ''
        if (this.derive.length) {
            console.log(`#[derive(${this.derive.join(", ")})]`)
        }
        if (model.operands.length > 0) {
            const operands = model.operands.map(x => `${vis}${this.resolveType(x)}`).join(", ")
            console.log(`${vis}struct ${model.name}(${operands});\n`)
        } else {
            console.log(`${vis}struct ${model.name};\n`)
        }
    }

    private generateStruct(model: StructSpec) {
        const vis = this.visibility ? `${this.visibility} ` : ''

        let s = ""
        if (this.derive.length) {
            s += `#[derive(${this.derive.join(", ")})]\n`
        }

        s += `${vis}struct ${model.name} {\n`
        
        const fields = Object.entries(model.fields).map(([key, value]) => {
            return `    ${vis}${key}: ${this.resolveType(value)},`
        })

        s += fields.join("\n")
        s += `\n}\n`
        console.log(s)
    }

    private generateEnum(model: EnumSpec) {
        const vis = this.visibility ? `${this.visibility} ` : ''
        let s = ""
        if (Object.values(model.cases).find(x => x.operands.length > 0) != null) {
            s += "#[repr(C, u8)]\n"
        }
        if (this.derive.length) {
            s += `#[derive(${this.derive.join(", ")})]\n`
        }
        s += `${vis}enum ${model.name} {\n`
        const cases = Object.entries(model.cases).map(([key, value]) => {
            if (value.operands.length === 0) {
                return `    ${key},`
            } else {
                return `    ${key}(${value.operands.map(x => this.resolveType(x)).join(", ")}),`
            }
        })

        s += cases.join("\n")
        s += `\n}\n`
        console.log(s)
    }

    private generateTaggedUnionImpl(model: EnumSpec) {
        const typeIds = Object.values(model.cases).map((value) => {
            if (value.operands.length !== 1) {
                return `            TypeId::of::<__Invalid>(),`
            } else {
                return `            TypeId::of::<${this.resolveType(value.operands[0])}>(),`
            }
        }).join("\n")
        const s = `unsafe impl TaggedUnion for ${model.name} {
    type Repr = u8;
    
    unsafe fn is<T: Any>(&self) -> bool {
        #[allow(dead_code)]
        enum __Invalid {}

        const TAGS: [TypeId; ${Object.keys(model.cases).length}] = [
${typeIds}
        ];

        TAGS[Self::tag(self) as usize] == TypeId::of::<T>()
    }
}
`
        console.log(s)
    }

    private generateTraceImpl(model: TopLevelSpec) {
        let items = []

        if (model instanceof TupleStructSpec) {
            for (let i = 0; i < model.operands.length; ++i) {
                items.push(`        self.${i}.trace(marker);`)
            }
        } else if (model instanceof EnumSpec) {
            items = Object.entries(model.cases).map(([key, value]) => {
                if (value.operands.length === 0) {
                    return `            ${model.name}::${key} => {},`
                } else {
                    return `            ${model.name}::${key}(${alphabet(value.operands.length).join(", ")}) => {
${alphabet(value.operands.length).map(x => `                ${x}.trace(marker);`).join("\n")}
            },`
                }
            })
            items.unshift("        match self {")
            items.push("        }")
        } else if (model instanceof StructSpec) {
            for (const field of Object.keys(model.fields)) {
                items.push(`        self.${field}.trace(marker);`)
            }
        } else {
            throw new TypeError("impossible")
        }

        const s = `impl Trace for ${model.name} {
    fn trace(&self, marker: &Marker) {
${items.join("\n")}
    }
}
`
        console.log(s)
    }

    private generateModels() {
        for (const model of this.models) {
            if (model instanceof TupleStructSpec) {
                this.generateTupleStruct(model)
            } else if (model instanceof EnumSpec) {
                this.generateEnum(model)
                this.generateTaggedUnionImpl(model)
            } else if (model instanceof StructSpec) {
                this.generateStruct(model)
            } else {
                throw new TypeError("impossible")
            }

            this.generateTraceImpl(model)
        }
    }

    private generateCastFns() {
        Object.entries(this.paths).forEach(([keyFrom, o]) => {
            Object.entries(o).forEach(([keyTo, path]) => {
                const fromType = this.models.find(x => x.name === keyFrom)
                if (fromType == null) {
                    throw new Error(`From type should not be null: ${keyFrom}`)
                }
                let toType = this.models.find(x => x.name === keyTo)
                // if (keyTo === "str") {
                //     toType = { name: "Box<str>" } as StructSpec
                // } else 
                if (toType == null) {
                    toType = { name: keyTo } as StructSpec
                }

                if (toType == null) {
                    throw new Error(`To type should not be null: ${keyTo}`)
                }

                let isLossless = false
                if (this.paths[keyTo] != null) {
                    if (this.paths[keyTo][keyFrom] != null) {
                        isLossless = true
                    }
                }

                this.generateCastFn(fromType, toType, path, isLossless)
            })
        })
    }

    private generateCastFn(fromType: TopLevelSpec, toType: TopLevelSpec, path: PathSpec[], isLossless: boolean) {
        const letExpr: string[] = []

        // const lastItem = path.length - 1
        let acc = { value: "value", wasBoxed: false }
        for (let i = path.length - 1; i >= 0; --i) {
            const cur = path[i]
            let item
            const { value } = acc

            const before = path[i - 1]
            const matchValue = before != null && before.typeSpec.isBoxed && !cur.typeSpec.isArray ? "*value" : "value"

            if (i === path.length - 1) {
                if (cur.typeSpec.isBoxed && !cur.typeSpec.isArray && cur.typeSpec.isSized) {
                    letExpr.unshift(`        if let ${cur.enumName}::${cur.enumCase}(value) = ${matchValue} { return Ok(*value) } else { return Err(CastError::new()) };`)
                    item = `${cur.enumName}::${cur.enumCase}(Box::new(${value}))`
                } else {
                    letExpr.unshift(`        if let ${cur.enumName}::${cur.enumCase}(value) = ${matchValue} { return Ok(value) } else { return Err(CastError::new()) };`)
                    item = `${cur.enumName}::${cur.enumCase}(${value})`
                }
            } else {
                if (cur.typeSpec.isBoxed && !cur.typeSpec.isArray && cur.typeSpec.isSized) {
                    letExpr.unshift(`        let value = if let ${cur.enumName}::${cur.enumCase}(value) = ${matchValue} { value } else { return Err(CastError::new()) };`)
                    item = `${cur.enumName}::${cur.enumCase}(Box::new(${value}))`
                } else {
                    letExpr.unshift(`        let value = if let ${cur.enumName}::${cur.enumCase}(value) = ${matchValue} { value } else { return Err(CastError::new()) };`)
                    item = `${cur.enumName}::${cur.enumCase}(${value})`
                }
            }
            acc = { value: item, wasBoxed: cur.typeSpec.isBoxed && !cur.typeSpec.isArray }
        }
        const fromExpr = acc.value
        // const fromExpr = path.reduceRight((acc, cur, index) => {
            
        // }, { value: "value", wasBoxed: false }).value

        const tryFrom = `\
impl TryFrom<${fromType.name}> for ${toType.name} {
    type Error = CastError<${fromType.name}, ${toType.name}>;

    fn try_from(value: ${fromType.name}) -> Result<Self, Self::Error> {
${letExpr.join("\n")}
    }
}
`
        const from = `\
impl From<${toType.name}> for ${fromType.name} {
    fn from(value: ${toType.name}) -> Self {
        ${fromExpr}
    }
}
`
        if (!isLossless) {
            console.log(tryFrom)
        }
        console.log(from)
    }

    private derivePaths(): Paths {
        const graph = new Graph({ directed: true })
        // Walk the models and generate paths
        for (const a of this.models) {
            if (a instanceof StructSpec) {
                for (const [key, value] of Object.entries(a.fields)) {
                    if (value.isArray) {
                        continue
                    }

                    const mid = `${a.name}.${key}`;
                    graph.setEdge(a.name, mid)
                    graph.setEdge(mid, this.resolveType(value, true))
                }
                continue
            }
                
            if (a instanceof TupleStructSpec) {
                for (let i = 0; i < a.operands.length; ++i) {
                    if (a.operands[i].isArray) {
                        continue
                    }
                    const mid = `${a.name}.${i}`;
                    graph.setEdge(a.name, mid)
                    graph.setEdge(mid, this.resolveType(a.operands[i], true))
                }
                continue
            }

            const caseSpecs = Object.entries(a.cases)
                .filter((x) => x[1].operands.length >= 1)

            for (const [key, case_] of caseSpecs) {
                for (const operand of case_.operands) {
                    if (operand.isArray) {
                        continue
                    }
                    const mid = `${a.name}::${key}#${case_.operands.length}`
                    const resolved = this.resolveType(operand, true)
                    graph.setEdge(a.name, mid)
                    graph.setEdge(mid, resolved)
                }
            }
        }

        const cycles = alg.findCycles(graph)
        console.error(cycles)

        for (const cycleList of cycles) {
            const causeType = cycleList.pop()

            for (const longEnumCase of cycleList.filter(x => x.includes("::"))) {
                const [parent, enumValue] = longEnumCase.split("::")
                const [enumCase, indexStr] = enumValue.split("#")
                const index = parseInt(indexStr, 10) - 1

                const model = this.models.find(x => x.name === parent) as EnumSpec
                const operand = model.cases[enumCase].operands[index]
                operand.isBoxed = true
            }

            for (const longStructField of cycleList.filter(x => x.includes("."))) {
                const [parent, structField] = longStructField.split(".")
                const structIndex = parseInt(structField, 10)
                if (!Number.isNaN(structIndex)) {
                    // Tuple struct
                    const model = this.models.find(x => x.name === parent) as TupleStructSpec
                    model.operands[structIndex].isBoxed = true

                } else {
                    // Ordinary struct
                    const model = this.models.find(x => x.name === parent) as StructSpec
                    model.fields[structField].isBoxed = true
                }

            }
        }

        const paths = Object.entries(alg.dijkstraAll(graph)).map(([topKey, topValue]) => {
            // console.error(topKey, topValue)
            if (topKey.includes("::") || topKey.includes(".")) {
                return {}
            }

            const paths = Object
                .entries(topValue)
                .map(([key, value]) => {
                    if (value.distance === Infinity) {
                        return null
                    }

                    const path = []
                    path.push(key)
                    
                    while ((key = value.predecessor) != null) {
                        path.push(key)
                        value = topValue[key]
                    }

                    path.pop()
                    path.reverse()

                    // Do some post-processing
                    if (path.length) {
                        if (path[path.length - 1].includes("::") || path.find(x => x.includes(".")) != null) {
                            return null
                        }
                        const newPath = [] 

                        let enumKey = null
                        let typeName = ""

                        for (const key of path) {
                            if (key.includes("::")) {
                                enumKey = key
                            } else if (enumKey != null) {
                                const [enumName, enumValue] = enumKey.split("::")
                                const [enumCase, enumIndexStr] = enumValue.split("#")
                                const enumIndex = parseInt(enumIndexStr, 0) - 1
                                if (enumIndex !== 0) {
                                    return null
                                }
                                const model = this.models.find(x => x.name === enumName) as EnumSpec
                                const type = model.cases[enumCase].operands[enumIndex]

                                // Special case for str
                                if (type.type === "str") {
                                    type.isSized = false
                                    typeName = "Box<str>"
                                } else {
                                    typeName = this.resolveType(type, true)
                                }

                                newPath.push({
                                    enumName,
                                    enumCase,
                                    typeName,
                                    typeSpec: type
                                })
                                enumKey = null
                            } else {
                                newPath.push(key)
                            }
                        }

                        return { [typeName]: newPath }
                    }

                    return null
                })
                .filter(x => x != null)
                .reduce((acc, cur) => Object.assign(acc, cur), {})
            if (paths == null || Object.keys(paths).length === 0) {
                return {}
            }
            return { [topKey]: paths }
        }).reduce((acc: Record<string, unknown>, cur) => {
            return Object.assign(acc, cur)
        })

        return paths as Paths
    }

    private generateTest() {
        const prints = this.models.map(x => `    println!("${x.name}: {}", std::mem::size_of::<${x.name}>());`)
        console.log(`#[cfg(test)]\n#[test]\nfn print_model_sizes() {
${prints.join("\n")}
}`)
    }

    private generateHeaders() {
        console.log("#![feature(const_type_id)]")
        console.log()
        console.log("use std::any::{Any, TypeId};")
        console.log("use std::convert::TryFrom;")
        console.log("use bcgc::*;")
        console.log()
        console.log("pub struct CastError<A: ?Sized + 'static, B: ?Sized + 'static>(std::marker::PhantomData<(&'static A, &'static B)>);")
        console.log("impl<A: ?Sized + 'static, B: ?Sized + 'static> CastError<A, B> { pub(crate) fn new() -> Self { Self(std::marker::PhantomData) } }")
        console.log()
    }

    generate() {
        this.generateHeaders()
        this.generateModels()
        this.generateCastFns()
        this.generateTest()
    }
}

function isArray(input: unknown): input is unknown[] {
    return typeOf(input) === JsType.Array
}

function isStringArray(input: unknown): input is string[] {
    if (typeOf(input) !== JsType.Array) {
        return false
    }

    if ((input as unknown[]).find(x => typeOf(x) != JsType.String)) {
        return false
    }

    return true
}

function isString(input: unknown): input is string {
    return typeOf(input) === JsType.String
}

class AstParser {
    private readonly ast: Ast

    constructor(ast: Ast) {
        this.ast = ast
    }

    private parseType(input: unknown): TypeSpec {
        if (isArray(input)) {
            // An empty array indicates an empty type
            if (input.length === 0) {
                return new TypeSpec(null)
            }

            // If it's one item, it indicates an array of something
            if (input.length === 1) {
                return new TypeSpec(this.parseType(input[0]), true)
            }

            // If it's more than one, it's a tuple-ish type
            throw new Error('tuple not supported in this position')
        } else if (isString(input)) {
            const isOptional = input.endsWith("?")
            const isBoxed = input.startsWith("~")

            let name: string = input
            
            if (isBoxed) {
                name = name.substring(1, name.length)
            }

            if (isOptional) {
                name = name.substring(0, name.length - 1)
            }

            const typeSpec = new TypeSpec(name)

            if (isBoxed) {
                typeSpec.isBoxed = true
            }

            if (isOptional) {
                typeSpec.isOptional = true
            }

            return typeSpec
        } else {
            throw new Error('no')
        }
    }

    private parseStruct(structName: string, structFields: Record<string, unknown>): StructSpec {
        const fields: { [name: string]: TypeSpec } = {}
    
        for (const [fieldName, fieldValue] of Object.entries(structFields)) {
            // const type = typeOf(fieldValue)
            const result = this.parseType(fieldValue)
            if (result != null) {
                fields[fieldName] = result
            } else {
                throw new Error("surprise null")
            }
        }
    
        return new StructSpec(structName, fields)
    }
    
    private parseEnumValueArray(array: unknown[]): CaseSpec {
        // Empty case
        if (array.length === 0) {
            return new CaseSpec([])
        }

        if (array.length === 1) {
            return new CaseSpec([this.parseType(array)])
        }

        return new CaseSpec(array.map(obj => this.parseType(obj)))
    }

    private parseEnum(enumName: string, enumValues: unknown[]): EnumSpec {
        const cases: { [name: string]: CaseSpec } = {}
    
        for (const value of enumValues) {
            const type = typeOf(value)
    
            if (type === JsType.String) {
                const v = value as string
                cases[v] = new CaseSpec([this.parseType(v)])
            } else if (type === JsType.Object) {
                const v = value as Record<string, unknown>
                const [key, innerTypeObj]: [string, unknown] = Object.entries(v)[0]
                const innerType = typeOf(innerTypeObj)
    
                if (innerType === JsType.String) {
                    cases[key] = new CaseSpec([this.parseType(innerTypeObj as string)])
                } else if (innerType === JsType.Array) {
                    cases[key] = this.parseEnumValueArray(innerTypeObj as unknown[])
                } else {
                    throw new Error(`Unknown type: ${type}`)
                }
            } else {
                throw new Error(`Unhandled JS type: ${type}`)
            }
        }
    
        return new EnumSpec(enumName, cases)
    }

    parse(): TopLevelSpec[] {
        // Parse into models
        const models: TopLevelSpec[] = Object.entries(this.ast.models).map(([key, value]) => {
            const type = typeOf(value)
            
            if (type === JsType.String) {
                return new TupleStructSpec(key, [this.parseType(value as string)])
            } else if (type === JsType.Object) {
                return this.parseStruct(key, value as Record<string, unknown>)
            } else if (type === JsType.Array) {
                if ((value as unknown[]).length <= 1) {
                    return new TupleStructSpec(key, (value as unknown[]).map(x => this.parseType(x)))
                }
                return this.parseEnum(key, value as unknown[])
            } else {
                console.log(`Warning: Unhandled type for key "${key}": ${type}`)
            }
        }).filter(x => x != null) as TopLevelSpec[]

        return models
    }
}

function main() {
    // Read the ast.yaml file from the current directory as a string
    const yamlData = fs.readFileSync("./ast.yaml", "utf8")

    // Parse the YAML string into a JavaScript object
    const obj = yaml.safeLoad(yamlData) as Ast | null

    if (obj == null) {
        throw new Error("Invalid input")
    }

    if (typeof obj.models !== "object") {
        throw new Error("Invalid input")
    }

    const parser = new AstParser(obj)
    const models = parser.parse()

    // console.log(JSON.stringify(models, null, 2))

    const generator = new RustGenerator(obj.config, models)
    generator.generate()
}

// Run our program
main()
