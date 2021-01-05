'use strict'

const escape = require('escape-latex')
const visit = require('unist-util-visit')
const path = require('path')
const util = require('./util')
const child_process = require('child_process')
const fs = require('fs')
const unified = require('unified')
const rparse = require('remark-parse')
const math = require('remark-math')
const details = require('remark-details')
const footnotes = require('remark-footnotes')
const request = require('sync-request')
const URL = require('url').URL

// 给 String 添加 format 方法，方便格式化输出
if (!String.prototype.format) {
	String.prototype.format = function () {
		const args = arguments
		return this.replace(/{(\d+)}/g, function (match, number) {
			return typeof args[number] != 'undefined' ? args[number] : match
		})
	}
}

module.exports = compiler

function compiler(options) {
	let links = {} // 引用式链接，键-值：标识符-链接地址
	let footnote = {} // 引用式脚注，键-值：序号（1 起始）-脚注内容
	let indices = {} // 脚注序号，键-值：标识符-脚注序号
	let identifiers = {} // indices 的逆映射
	let footnoteRefs = {} // 脚注被引用的次数，键-值：标识符-引用次数
	let footnoteRefId = {} // 脚注当前被引用第几次，键-值：脚注序号-第几次引用
	let footnoteCount = 0 // 脚注数量

	parser.prototype.compile = wrapper
	return parser

	function parser(tree, file) {
		this.tree = tree
		this.file = file
	}

	function wrapper() {
		// 处理掉所有标签定义和链接跳转定义
		parseDefinition(this.tree)
		// 解析文章
		let article = '% Generated by remark-latex\n'
		article += parse(this.tree)
		// 创建文章尾注
		if (footnoteCount > 0) {
			article += '\n\\begin{enumerate}\n'
			for (let id = 1; id <= footnoteCount; ++id) {
				const fullLabel = options.prefix + identifiers[id]
				if (footnoteRefs[identifiers[id]] === 1) {
					article += '\\renewcommand{\\labelenumi}{\\hyperref[endnoteref:{0}-1]{[\\theenumi]}}\n'.format(fullLabel)
				} else {
					article += '\\renewcommand{\\labelenumi}{[\\theenumi]}\n'
				}
				article += '\\item\\label{endnote:{0}}'.format(fullLabel) + footnote[id]
				if (footnoteRefs[identifiers[id]] >= 2) {
					for (let cnt = 1; cnt <= footnoteRefs[identifiers[id]]; ++cnt) {
						article += ' \\hyperref[endnoteref:{0}-{1}]{[{2}-{3}]}'.format(fullLabel, cnt, id, cnt)
					}
				}
				article += '\n'
			}
			article += '\\end{enumerate}\n'
		}
		return article
	}

	// 估测文本长度
	function getEstimatedLength(node) {
		let ans = 0
		if ('value' in node) {
			ans += util.getTextEstimatedLength(node.value)
		}
		if ('children' in node && node.children.length > 0) {
			ans += util.all(node, getEstimatedLength).reduce((prev, val) => prev + val)
		}
		return ans
	}

	function parseDefinition(tree) {
		visit(tree, 'definition', function (node) {
			links[node.identifier] = escape(node.url)
		})
		visit(tree, 'footnoteDefinition', function (node) {
			indices[node.identifier] = ++footnoteCount
			identifiers[footnoteCount] = node.identifier
			footnoteRefId[footnoteCount] = 0
			footnoteRefs[node.identifier] = 0
			footnote[footnoteCount] = util.nonParagraphBegin(util.all(node, parse).join('')).trim()
		})
		visit(tree, 'footnoteReference', function (node) {
			++footnoteRefs[node.identifier]
		})
	}

	function parse(node) {
		const makeLink = function (url) {
			const raw = util.all(node, parse).join('')

			let prevForce = options.forceEscape
			options.forceEscape = true
			const children = util.all(node, parse).join('')
			options.forceEscape = prevForce

			if (util.isInternalLink(url)) {
				const location = util.toPrefix(util.joinRelative(url, options))
				return (location !== '' && raw !== '') ? '\\hyperref[sect:{0}]{{1}}'.format(location, children) : ''
			} else {
				const location = escape(url)
				if (location === raw) {
					return '\\hyref{{0}}{{1}}'.format(location, children)
				} else {
					return (location !== '' && raw !== '') ? '\\hyref{{0}}{{1}}'.format(location, children) : ''
				}
			}
		}

		// 插入图片，若是网络资源则先下载到本地再插入
		const makeImage = function (loc) {
			let uri = util.joinRelative(node.url, options);
			try {
				let ext = ''
				let dest = ''
				if (util.isUrl(loc)) {
					const url = new URL(loc)
					ext = path.extname(url.pathname)
					dest = path.join('images', util.toPrefix(path.join(path.dirname(uri), path.basename(url.pathname, ext))) + ext)
					// download
					if (!fs.existsSync(dest)) {
						let body = request('GET', loc).getBody()
						fs.writeFileSync(dest, body)
					}
					uri = dest
				} else {
					ext = path.extname(loc)
				}
				dest = path.join('images', util.toPrefix(path.join(path.dirname(uri), path.basename(uri, path.extname(uri)))) + '.jpg')
				// convert
				switch (ext) {
					case '.jpg':
					case '.jpeg': {
						if (!fs.existsSync(dest)) {
							fs.copyFileSync(uri, dest)
						}
						break
					}
					default: {
						if (!fs.existsSync(dest)) {
							// 混合白色背景（原图可能是 PNG 透明图）
							child_process.execFileSync('convert', ['-background', 'white', '-flatten', ext === '.gif' ? uri + '[0]' : uri, dest])
						}
						break
					}
				}
				return '\\begin{figure}[htbp]\n\\centering\n\\includegraphics[max width=0.7\\textwidth, max height=0.4\\textheight]{{{0}}}\n\\caption{{1}}\\end{figure}'.format(path.basename(dest, '.jpg'), escape(node.alt || ''))
			} catch (e) {
				console.log('Error occurred when processing image file `{0}`'.format(uri))
				return ''
			}
		}

		switch (node.type) {
			case 'root': {
				let article = util.trailingLineFeed(util.all(node, parse).join('\n'))
				if (!options.nested) {
					article = '\\label{sect:{0}}\n'.format(options.prefix) + article
				}
				return article
			}
			case 'paragraph': {
				return '\\par {0}'.format(util.all(node, parse).join(''))
			}
			case 'heading': {
				const block = ['chapter', 'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph']
				const depth = Math.min(options.depth + Math.max(node.depth, 2) - 2, 5)
				return '\\{0}*{{1}}'.format(block[depth], util.all(node, parse).join(''))
			}
			case 'text': {
				if (options.forceEscape) {
					return escape(util.forceLinebreak(node.value))
				} else {
					return escape(node.value)
				}
			}
			case 'emphasis': {
				return '\\emph{{0}}'.format(util.all(node, parse).join(''))
			}
			case 'strong': {
				return '{\\bfseries {0}}'.format(util.all(node, parse).join(''))
			}
			case 'inlineCode': {
				return '\\hytt{{0}}'.format(escape(util.forceLinebreak(node.value)))
			}
			case 'code': {
				return '\n\\begin{minted}[]{{0}}\n{1}\\end{minted}\n'.format(
					(function (lang) {
						if (!lang) { // 默认当作 text
							return 'text'
						} else if (lang === 'plain') { // plain 替换为 text（纯文本）
							return 'text'
						} else if (lang === 'markdown') { // markdown 格式的说明符必须是 md，需要替换
							return 'md'
						} else {
							return lang
						}
					})(node.lang),
					node.value.replace('\t', '    ').split('\n').map(function (line) {
						const lineLimit = 80 // 每行最多 80 字（不过这样做其实会有些 bug，但是因为 minted 开了 breaklines 和 breakanywhere 后有谜之报错就只能这样了）
						let ans = ''
						for (let i = 0, j = 0; i < line.length; ++i) {
							if (j >= lineLimit) {
								j = 0
								ans += '\n'
							}
							ans += line[i]
							j += (util.isCjk(line[i]) ? 2 : 1)
						}
						return ans
					}).join('\n') + '\n'
				)
			}
			case 'delete': {
				return util.all(node, parse).join('').split('').map(char => '\\sout{' + escape(char) + '}').join('\u200b')
			}
			case 'list': {
				return '\\begin{{0}}{1}\n{2}\\end{{0}}'.format(
					node.ordered ? 'enumerate' : 'itemize',
					(!node.ordered || (node.start === 1)) ? '' : node.ordered ? '\n\\setcounter{enumi}{{0}}'.format(node.start - 1) : '',
					util.all(node, parse).join('')
				)
			}
			case 'listItem': {
				if (node.checked === null) {
					return '\\item {0}\n'.format(util.nonParagraphBegin(util.all(node, parse).join('')))
				} else {
					// TODO: 此处复选列表并未完全实现，下面的代码无法通过 XeLaTeX 编译
					// 但反正 OI Wiki 文章里也没有，问题不大
					return '\\begin{todolist}\n\\item {0} {1}\n\\end{todolist}\n'.format(node.checked ? '[\\done]' : '', util.all(node, parse).join(''))
				}
			}
			case 'thematicBreak': { // 水平分割线
				return '\\vskip 0.5em' // 在印刷物中使用水平分割线也须不是好的实践
			}
			case 'blockquote': {
				return '\\begin{quotation}\n{0}\\end{quotation}'.format(util.all(node, parse).join(''))
			}
			case 'break': {
				return '\n\n'
			}
			case 'yaml': {
				return '' // YAML front-matter，这里直接忽略
			}
			case 'html': {
				return '' // HTML 标签（不含标签里的内容，如 <kbd>A</kbd> 会分别产生一个 html('<kbd>'), text('A'), html('</kbd>')，这里直接忽略掉就行
			}
			case 'link': {
				return makeLink(node.url)
			}
			case 'linkReference': {
				if (links[node.identifier]) {
					return makeLink(links[node.identifier])
				}
				return ''
			}
			case 'image': {
				return makeImage(node.url.toLowerCase())
			}
			case 'imageReference': {
				if (links[node.identifier]) {
					return makeImage(links[node.identifier])
				} else {
					return ''
				}
			}
			case 'table': {
				// 如果表格有多余列（相对表头）则去掉
				node.children.map(function (child) {
					child.children = child.children.slice(0, node.align.length)
				})
				// 估测每列最宽字符串的宽度，为每列分配水平空间
				let width = Array(node.align.length)
				width.fill(0)
				for (let child = 0; child < node.children.length; ++child) {
					for (let id = 0; id < node.children[child].children.length; ++id) {
						width[id] = Math.min(Math.max(width[id], getEstimatedLength(node.children[child].children[id])), 60)
					}
				}
				// 用 longtabu 环境创建可自动适应比例、可自动分页的长表格
				return `\\begin{longtabu}to\\linewidth[c]{{0}}
\\toprule
{1}\\midrule
\\endfirsthead
\\toprule
{1}\\midrule
\\endhead
\\bottomrule
\\endfoot
\\bottomrule
\\endlastfoot
{2}\\end{longtabu}`.format(
					Array.from(Array(node.align.length).keys()).map(id => ('X[' + width[id] + ',' + (node.align[id] == null ? 'c' : node.align[id].substr(0, 1)) + ',m]')).join(''),
					parse(node.children[0]),
					// 每行之间的分割线
					node.children.slice(1).map(parse).join('\\specialrule{0em}{0.4em}{0.4em}')
				)
			}
			case 'tableRow': {
				return util.all(node, parse).join(' & ') + ' \\\\\n'
			}
			case 'tableCell': {
				return util.all(node, parse).join('')
			}
			case 'footnote': {
				return '\\footnote{{0}}'.format(util.all(node, parse).join(''))
			}
			case 'footnoteReference': {
				const index = indices[node.identifier]
				const fullLabel = options.prefix + node.identifier
				const refId = ++footnoteRefId[index]
				return '\\textsuperscript{\\label{endnoteref:{0}-{1}}\\hyperref[endnote:{2}]{[{3}{4}]}}'.format(fullLabel, refId, fullLabel, index, footnoteRefs[node.identifier] > 1 ? '-{0}'.format(refId) : '')
			}
			case 'definition': {
				return '' // 已经预处理掉了
			}
			case 'footnoteDefinition': {
				return '' // 已经预处理掉了
			}
			case 'inlineMath': { // 行内公式
				const nowrap = ['\\LaTeX', '\\TeX'] // 碰到这两个命令时不套 $ 标记
				const escapeList = ['textit', 'textbf', 'text'] // 内部转义字符串的命令
				for (let id in nowrap) {
					if (node.value.indexOf(nowrap[id]) !== -1) {
						return util.escapeTextCommand(escapeList, node.value);
					}
				}
				return '${0}$'.format(util.escapeTextCommand(escapeList, node.value))
			}
			case 'math': { // 行间公式
				const nowrap = ['{equation}', '{equation*}', '{align}', '{align*}', '{eqnarray}', '{eqnarray*}']
				const escapeList = ['textit', 'textbf', 'text']
				for (let id in nowrap) {
					if (node.value.indexOf(nowrap[id]) !== -1) {
						return util.escapeTextCommand(escapeList, node.value);
					}
				}
				return '\\begin{equation*}\n{0}\n\\end{equation*}\n'.format(util.escapeTextCommand(escapeList, node.value))
			}
			case 'details': { // Pymdown details 语法块
				let type = (node.value || '').toLowerCase().trim() == 'warning' ? 'Warning' : 'Note'
				const prevNested = options.nested
				options.nested = true
				let title = parse(unified()
					.use(rparse)
					.use(math)
					.use(details)
					.use(footnotes)
					.parse(node.title ? node.title : type)
				)
				options.nested = prevNested
				let color = type === 'Warning' ? 'warning-orange' : 'info-blue'
				return '\\begin{details}{{0}}{{1}}\n{2}\n\\end{details}'.format(color, title, util.all(node, parse).join(''))
			}
			default: {
				console.error('Unsupported node type: {0}'.format(node.type))
				console.error(JSON.stringify(node, null, '\t'))
				return ''
			}
		}
	}
}
