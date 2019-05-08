import {GrammarDeclaration, RuleDeclaration, PrecDeclaration,
        TokenPrecDeclaration, TokenDeclaration, ExternalTokenDeclaration,
        Identifier, Expression,
        NamedExpression, ChoiceExpression, SequenceExpression, LiteralExpression,
        RepeatExpression, SetExpression, AnyExpression, ConflictMarker} from "./node"

// Note that this is the parser for grammar files, not the generated parser

let word = /[\w_$]+/gy
// Some engines (specifically SpiderMonkey) have still not implemented \p
try { word = /[\p{Alphabetic}\d_$]+/ugy } catch (_) {}

const none: readonly any[] = []

export class Input {
  type = "sof"
  value: any = null
  start = 0
  end = 0
  
  constructor(readonly string: string,
              readonly fileName: string | null = null) {
    this.next()
  }

  lineInfo(pos: number) {
    for (let line = 1, cur = 0;;) {
      let next = this.string.indexOf("\n", cur)
      if (next > -1 && next < pos) {
        ++line
        cur = next + 1
      } else {
        return {line, ch: pos - cur}
      }
    }
  }

  message(msg: string, pos: number = -1): string {
    let posInfo = this.fileName || ""
    if (pos > -1) {
      let info = this.lineInfo(pos)
      posInfo += (posInfo ? " " : "") + info.line + ":" + info.ch
    }
    return posInfo ? msg + ` (${posInfo})` : msg
  }

  raise(msg: string, pos: number = -1): never {
    throw new SyntaxError(this.message(msg, pos))
  }

  match(pos: number, re: RegExp) {
    let match = re.exec(this.string.slice(pos))
    return match ? pos + match[0].length : -1
  }

  next() {
    let start = this.match(this.end, /^(\s|\/\/.*|\/\*[^]*?\*\/)*/)
    if (start == this.string.length) return this.set("eof", null, start, start)

    let next = this.string[start]
    if (next == '"') {
      let end = this.match(start + 1, /^(\\.|[^"])*"/)
      if (end == -1) this.raise("Unterminated string literal", start)
      return this.set("string", readString(this.string.slice(start, end)), start, end)
    } else if (next == "'") {
      let end = this.match(start + 1, /^(\\.|[^'])*'/)
      if (end == -1) this.raise("Unterminated string literal", start)
      return this.set("string", readString(this.string.slice(start, end)), start, end)
    } else if (next == "[") {
      let end = this.match(start + 1, /^(?:\\.|[^\]])*\]/)
      if (end == -1) this.raise("Unterminated character set", start)
      return this.set("set", this.string.slice(start + 1, end - 1), start, end)
    } else if (/[()!~+*?{}<>\.,|=]/.test(next)) {
      return this.set(next, null, start, start + 1)
    } else {
      word.lastIndex = start
      let m = word.exec(this.string)
      if (!m) return this.raise("Unexpected character " + JSON.stringify(next), start)
      return this.set("id", m[0], start, start + m[0].length)
    }
  }

  set(type: string, value: any, start: number, end: number) {
    this.type = type
    this.value = value
    this.start = start
    this.end = end
  }

  eat(type: string, value: any = null) {
    if (this.type == type && (value == null || this.value === value)) {
      this.next()
      return true
    } else {
      return false
    }
  }

  unexpected(): never {
    return this.raise(`Unexpected token '${this.string.slice(this.start, this.end)}'`, this.start)
  }

  expect(type: string, value: any = null) {
    if (!this.eat(type, value)) this.unexpected()
  }

  parse() {
    return parseTop(this)
  }
}

function parseTop(input: Input) {
  let start = input.start
  let rules: RuleDeclaration[] = []
  let prec: PrecDeclaration | null = null
  let tokens: TokenDeclaration | null = null
  let skip: RuleDeclaration | null = null
  let external: ExternalTokenDeclaration[] = []

  while (input.type != "eof") {
    if (input.type == "id" && input.value == "tokens") {
      if (tokens) input.raise(`Multiple tokens declaractions`, input.start)
      else tokens = parseTokens(input)
    } else if (input.type == "id" && input.value == "external") {
      external.push(parseExternalTokens(input))
    } else if (input.type == "id" && input.value == "precedence") {
      if (prec) input.raise(`Multiple precedence declarations`, input.start)
      else prec = parsePrecedence(input)
    } else if (input.type == "id" && input.value == "skip") {
      skip = parseRule(input, false)
    } else {
      rules.push(parseRule(input, false))
    }
  }
  return new GrammarDeclaration(start, rules, tokens, external, prec, skip)
}

function parseRule(input: Input, isToken: boolean) {
  let id = parseIdent(input), params: Identifier[] = [], tag: Identifier | null = null
  let start = input.start

  if (input.eat("<")) while (!input.eat(">")) {
    if (params.length) input.expect(",")
    params.push(parseIdent(input))
  }
  if (input.eat("=")) tag = parseIdent(input)
  input.expect("{")
  let expr = parseExprChoice(input)
  input.expect("}")
  return new RuleDeclaration(start, id, tag, params, expr)
}

const SET_MARKER = "\ufdda" // (Invalid unicode character)

function parseExprInner(input: Input): Expression {
  let start = input.start
  if (input.eat("(")) {
    let expr = parseExprChoice(input)
    input.expect(")")
    return expr
  }

  if (input.type == "string") {
    let value = input.value
    input.next()
    if (value.length == 0) return new SequenceExpression(start, none, [none, none])
    return new LiteralExpression(start, value)
  } else if (input.eat("id", "_")) {
    return new AnyExpression(start)
  } else if (input.type == "set") {
    let content = input.value, invert = false
    if (/^\^/.test(content)) {
      invert = true
      content = content.slice(1)
    }
    let unescaped = readString('"' + content.replace(/\\.|-|"/g, (m: string) => {
      return m == "-" ? SET_MARKER : m == '"' ? '\\"' : m
    }) + '"') as string
    let ranges: [number, number][] = []
    for (let pos = 0; pos < unescaped.length;) {
      let code = unescaped.codePointAt(pos)!
      pos += code > 0xffff ? 2 : 1
      if (pos < unescaped.length - 1 && unescaped[pos] == SET_MARKER) {
        let end = unescaped.codePointAt(pos + 1)!
        pos += end > 0xffff ? 3 : 2
        if (end < code) input.raise("Invalid character range", input.start)
        addRange(input, ranges, code, end + 1)
      } else {
        addRange(input, ranges, code, code + 1)
      }
    }
    input.next()
    return new SetExpression(start, ranges.sort((a, b) => a[0] - b[0]), invert)
  } else {
    let id = parseIdent(input), namespace = null
    if (input.eat(".")) {
      namespace = id
      id = parseIdent(input)
    }
    let args = []
    if (input.eat("<")) while (!input.eat(">")) {
      if (args.length) input.expect(",")
      args.push(parseExprChoice(input))
    }
    return new NamedExpression(start, namespace, id, args)
  }
}

function addRange(input: Input, ranges: [number, number][], from: number, to: number) {
  if (!ranges.every(([a, b]) => b <= from || a >= to))
    input.raise("Overlapping character range", input.start)
  ranges.push([from, to])
}

function parseExprSuffix(input: Input): Expression {
  let start = input.start
  let expr = parseExprInner(input), kind = input.type
  if (kind == "*" || kind == "?" || kind == "+") {
    input.next()
    return new RepeatExpression(start, expr, kind)
  }
  return expr
}

function endOfSequence(input: Input) {
  return input.type == "}" || input.type == ")" || input.type == "|" || input.type == "/" ||
    input.type == "/\\" || input.type == "{" || input.type == "," || input.type == ">"
}

function parseExprSequence(input: Input) {
  let start = input.start, exprs: Expression[] = [], markers = [none]
  do {
    // Add markers at this position
    for (;;) {
      let localStart = input.start, markerType!: "ambig" | "prec"
      if (input.eat("~")) markerType = "ambig"
      else if (input.eat("!")) markerType = "prec"
      else break
      markers[markers.length - 1] =
        markers[markers.length - 1].concat(new ConflictMarker(localStart, parseIdent(input), markerType))
    }
    if (exprs.length && endOfSequence(input)) break
    exprs.push(parseExprSuffix(input))
    markers.push(none)
  } while (!endOfSequence(input))
  if (exprs.length == 1 && markers.every(ms => ms.length == 0)) return exprs[0]
  return new SequenceExpression(start, exprs, markers)
}

function parseExprChoice(input: Input) {
  let start = input.start, left = parseExprSequence(input)
  if (!input.eat("|")) return left
  let exprs: Expression[] = [left]
  do { exprs.push(parseExprSequence(input)) }
  while (input.eat("|"))
  return new ChoiceExpression(start, exprs)
}

function parseIdent(input: Input) {
  if (input.type != "id") input.unexpected()
  let start = input.start, name = input.value
  input.next()
  return new Identifier(start, name)
}

function parsePrecedence(input: Input) {
  let start = input.start
  input.next()
  input.expect("{")
  let items: {id: Identifier, type: "left" | "right" | "cut" | null}[] = []
  while (!input.eat("}")) {
    if (items.length) input.expect(",")
    items.push({
      id: parseIdent(input),
      type: input.eat("id", "left") ? "left" : input.eat("id", "right") ? "right" : input.eat("id", "cut") ? "cut" : null
    })
  }
  return new PrecDeclaration(start, items)
}
      
function parseTokens(input: Input) {
  let start = input.start
  input.next()
  input.expect("{")
  let tokenRules: RuleDeclaration[] = []
  let precedence = null
  while (!input.eat("}")) {
    if (input.type == "id" && input.value == "precedence") {
      if (precedence) input.raise("Multiple token precedence declarations", input.start)
      precedence = parseTokenPrecedence(input)
    } else {
      tokenRules.push(parseRule(input, true))
    }
  }
  return new TokenDeclaration(start, precedence, tokenRules)
}

function parseTokenPrecedence(input: Input) {
  let start = input.start
  input.next()
  input.expect("{")
  let tokens: (LiteralExpression | NamedExpression)[] = []
  while (!input.eat("}")) {
    if (tokens.length) input.expect(",")
    let expr = parseExprInner(input)
    if (expr instanceof LiteralExpression || expr instanceof NamedExpression)
      tokens.push(expr)
    else
      input.raise(`Invalid expression in token precedences`, expr.start)
  }
  return new TokenPrecDeclaration(start, tokens)
}

function parseExternalTokens(input: Input) {
  let start = input.start
  input.next()
  input.expect("id", "tokens")
  let id = parseIdent(input)
  input.expect("id", "from")
  let from = input.value
  input.expect("string")
  let tokens: {id: Identifier, tag: Identifier | null}[] = []
  input.expect("{")
  while (!input.eat("}")) {
    if (tokens.length) input.expect(",")
    let id = parseIdent(input)
    let tag = input.eat("=") ? parseIdent(input) : null
    tokens.push({id, tag})
  }
  return new ExternalTokenDeclaration(start, id, from, tokens)
}

function readString(string: string) {
  // Can't use JSON.parse because it has too limited support for
  // escape sequences, can't be bothered to write a custom reader.

  // FIXME maybe .replace the necessary escapes (such as \u{}) and
  // then feed to JSON.parse?
  return (1,eval)(string)
}
