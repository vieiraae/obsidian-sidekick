import {Editor, MarkdownView, Menu, Notice} from 'obsidian';
import type SidekickPlugin from './main';

/** Editor context-menu actions available via Sidekick. */
interface TextAction {
	label: string;
	icon: string;
	prompt: (text: string) => string;
}

const SYSTEM_MESSAGE =
	'You are a text editor assistant. When given text to transform, return ONLY the transformed text. ' +
	'Do not include any explanations, introductions, conclusions, or markdown code fences. ' +
	'Do not wrap the output in quotes. Return the plain transformed text directly.';

const ACTIONS: TextAction[] = [
	{
		label: 'Fix grammar and spelling',
		icon: 'check-check',
		prompt: (t) => `Fix all grammar and spelling errors in the following text:\n\n${t}`,
	},
	{
		label: 'Summarize',
		icon: 'list',
		prompt: (t) => `Summarize the following text concisely:\n\n${t}`,
	},
	{
		label: 'Elaborate',
		icon: 'expand',
		prompt: (t) => `Elaborate on the following text, adding more detail and depth:\n\n${t}`,
	},
	{
		label: 'Answer',
		icon: 'message-circle',
		prompt: (t) => `Answer the question or respond to the following text:\n\n${t}`,
	},
	{
		label: 'Explain',
		icon: 'lightbulb',
		prompt: (t) => `Explain the following text in simple, clear terms:\n\n${t}`,
	},
	{
		label: 'Rewrite',
		icon: 'pencil',
		prompt: (t) => `Rewrite the following text to improve clarity and readability:\n\n${t}`,
	},
];

/**
 * Register a "Sidekick" submenu on the editor right-click context menu.
 * Each action sends the selected text to the Copilot SDK and replaces
 * the selection with the response.
 */
export function registerEditorMenu(plugin: SidekickPlugin): void {
	plugin.registerEvent(
		plugin.app.workspace.on('editor-menu', (menu: Menu, editor: Editor, view: MarkdownView) => {
			const selection = editor.getSelection();
			if (!selection || !selection.trim()) return;

			menu.addItem((item) => {
				item.setTitle('Sidekick')
					.setIcon('brain');

				// Build submenu with all actions
				const submenu: Menu = (item as unknown as {setSubmenu: () => Menu}).setSubmenu();
				for (const action of ACTIONS) {
					submenu.addItem((sub) => {
						sub.setTitle(action.label)
							.setIcon(action.icon)
							.onClick(() => void runAction(plugin, editor, selection, action));
					});
				}
			});
		}),
	);
}

async function runAction(
	plugin: SidekickPlugin,
	editor: Editor,
	selectedText: string,
	action: TextAction,
): Promise<void> {
	if (!plugin.copilot) {
		new Notice('Copilot is not configured. Go to Settings → Sidekick.');
		return;
	}

	const notice = new Notice(`Sidekick: ${action.label}…`, 0);

	try {
		const result = await plugin.copilot.chat({
			prompt: action.prompt(selectedText),
			systemMessage: SYSTEM_MESSAGE,
		});

		if (!result) {
			notice.hide();
			new Notice('Sidekick: No response received.');
			return;
		}

		// Replace the current selection with the response (trim surrounding whitespace)
		editor.replaceSelection(result.trim());
		notice.hide();
		new Notice(`Sidekick: ${action.label} — done.`);
	} catch (e) {
		notice.hide();
		console.error('Sidekick: editor action error', e);
		new Notice(`Sidekick: Error — ${String(e)}`);
	}
}
