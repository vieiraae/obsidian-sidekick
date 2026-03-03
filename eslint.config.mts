import tseslint from 'typescript-eslint';
import globals from "globals";
import { globalIgnores } from "eslint/config";

/** Known brand names / acronyms that should NOT be lowercased. */
const ALLOWED_UPPERCASE = new Set([
	'Sidekick', 'Copilot', 'Markdown', 'GitHub', 'URL', 'API', 'LLM',
	'MCP', 'CLI', 'JSON', 'YAML', 'HTML', 'CSS', 'UI', 'ID',
	'Settings', 'Community', 'Enter',
]);

/**
 * Check whether a string literal is in sentence case.
 * Sentence case = first letter uppercase, remaining words lowercase
 * unless they are brand names or acronyms.
 */
function isSentenceCase(text: string): boolean {
	// Skip very short strings, template-like strings, paths, URLs, placeholders
	if (text.length < 2) return true;
	// Skip placeholder-style strings (e.g. …, ghp_…, sk-…, model-id, localhost:)
	if (/^(e\.g\.|ghp_|sk-|token|model-|localhost)/i.test(text)) return true;
	// Skip strings that start with a known brand/product followed by ':'
	const brandPrefixMatch = text.match(/^(\w+):/);
	if (brandPrefixMatch && ALLOWED_UPPERCASE.has(brandPrefixMatch[1])) return true;
	if (/^[a-z]/.test(text)) return false; // must start uppercase
	// Split into sentences (after . ! ?) and check each independently
	const sentences = text.split(/(?<=[.!?])\s+/);
	for (const sentence of sentences) {
		const words = sentence.split(/\s+/);
		// Start from word index 1 for the first sentence, 0th word of subsequent sentences is ok (new sentence)
		const startIdx = sentence === sentences[0] ? 1 : 1;
		for (let i = startIdx; i < words.length; i++) {
			const word = words[i].replace(/[^a-zA-Z]/g, '');
			if (!word) continue;
			if (ALLOWED_UPPERCASE.has(word)) continue;
			// If word starts uppercase and is not an allowed name, flag it
			if (/^[A-Z]/.test(word) && !/^[A-Z]+$/.test(word)) return false;
		}
	}
	return true;
}

export default tseslint.config(
	...tseslint.configs.recommended,
	{
		files: ['src/**/*.ts'],
		plugins: {
			'sidekick-custom': {
				rules: {
					'ui-sentence-case': {
						meta: {
							type: 'suggestion',
							docs: { description: 'Enforce sentence case for UI text in setTitle, setText, setPlaceholder, Notice, and button labels' },
							messages: {
								notSentenceCase: 'UI text "{{text}}" should use sentence case.',
							},
							schema: [],
						},
						create(context: { report: (opts: { node: unknown; messageId: string; data: Record<string, string> }) => void }) {
							const UI_METHODS = new Set(['setTitle', 'setText', 'setPlaceholder', 'setName', 'setDesc']);
							return {
								// .setTitle('Text'), .setText('Text'), etc.
								CallExpression(node: { callee?: { type?: string; property?: { name?: string } }; arguments?: Array<{ type?: string; value?: unknown }> }) {
									if (
										node.callee?.type === 'MemberExpression' &&
										typeof node.callee.property?.name === 'string' &&
										UI_METHODS.has(node.callee.property.name)
									) {
										const arg = node.arguments?.[0];
										if (arg?.type === 'Literal' && typeof arg.value === 'string') {
											if (!isSentenceCase(arg.value)) {
												context.report({ node: arg as unknown as never, messageId: 'notSentenceCase', data: { text: arg.value } });
											}
										}
									}
									// new Notice('Text')
									if (
										node.callee?.type === 'Identifier' &&
										(node.callee as unknown as { name: string }).name === 'Notice'
									) {
										const arg = node.arguments?.[0];
										if (arg?.type === 'Literal' && typeof arg.value === 'string') {
											if (!isSentenceCase(arg.value)) {
												context.report({ node: arg as unknown as never, messageId: 'notSentenceCase', data: { text: arg.value } });
											}
										}
									}
								},
								// new Notice('Text') via NewExpression
								NewExpression(node: { callee?: { type?: string; name?: string }; arguments?: Array<{ type?: string; value?: unknown }> }) {
									if (
										node.callee?.type === 'Identifier' &&
										node.callee.name === 'Notice'
									) {
										const arg = node.arguments?.[0];
										if (arg?.type === 'Literal' && typeof arg.value === 'string') {
											if (!isSentenceCase(arg.value)) {
												context.report({ node: arg as unknown as never, messageId: 'notSentenceCase', data: { text: arg.value } });
											}
										}
									}
								},
								// createEl('button', {text: 'Text'})
								// createEl('label', {text: 'Text'})
							};
						},
					},
				},
			},
		},
		rules: {
			'sidekick-custom/ui-sentence-case': 'error',
		},
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						'eslint.config.js',
						'manifest.json'
					]
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json']
			},
		},
	},
	globalIgnores([
		"node_modules",
		"dist",
		"esbuild.config.mjs",
		"eslint.config.js",
		"version-bump.mjs",
		"versions.json",
		"main.js",
	]),
);
