/**
 * Shared task definitions used by the editor context menu, the gutter
 * brain-button, and the Edit modal.  Add a task here and it appears
 * everywhere automatically.
 */

/** A single task the user can invoke on selected text. */
export interface TextTask {
	/** Machine-stable label (used as setting value and prompt parameter). */
	label: string;
	/** Emoji prefix shown in dropdown options. */
	emoji: string;
	/** Lucide icon name used in menus. */
	icon: string;
	/** Prompt template — receives the selected text. */
	prompt: (text: string) => string;
}

/** Canonical ordered list of tasks. */
export const TASKS: readonly TextTask[] = [
	{
		label: 'Rewrite',
		emoji: '✏️',
		icon: 'pencil',
		prompt: (t) => `Rewrite the following text to improve clarity and readability:\n\n${t}`,
	},
	{
		label: 'Proofread',
		emoji: '🔍',
		icon: 'check-check',
		prompt: (t) => `Proofread and fix all grammar, spelling, and punctuation errors in the following text:\n\n${t}`,
	},
	{
		label: 'Use synonyms',
		emoji: '🔄',
		icon: 'replace',
		prompt: (t) => `Replace words with appropriate synonyms to improve variety while preserving meaning:\n\n${t}`,
	},
	{
		label: 'Minor revise',
		emoji: '🩹',
		icon: 'eraser',
		prompt: (t) => `Make minor revisions to polish the following text without changing its meaning or structure:\n\n${t}`,
	},
	{
		label: 'Major revise',
		emoji: '🔧',
		icon: 'wrench',
		prompt: (t) => `Significantly revise the following text, improving structure, flow, and clarity:\n\n${t}`,
	},
	{
		label: 'Describe',
		emoji: '🖼️',
		icon: 'image',
		prompt: (t) => `Describe the following text, providing a clear explanation of what it conveys:\n\n${t}`,
	},
	{
		label: 'Answer',
		emoji: '💬',
		icon: 'message-circle',
		prompt: (t) => `Answer the question or respond to the following text:\n\n${t}`,
	},
	{
		label: 'Explain',
		emoji: '💡',
		icon: 'lightbulb',
		prompt: (t) => `Explain the following text in simple, clear terms:\n\n${t}`,
	},
	{
		label: 'Expand',
		emoji: '📌',
		icon: 'expand',
		prompt: (t) => `Expand on the following text, adding more detail and depth:\n\n${t}`,
	},
	{
		label: 'Summarize',
		emoji: '📝',
		icon: 'list',
		prompt: (t) => `Summarize the following text concisely:\n\n${t}`,
	},
] as const;

/** Task label union type. */
export type TaskLabel = typeof TASKS[number]['label'];

/** All task labels as a simple array (for dropdowns / iteration). */
export const TASK_LABELS = TASKS.map((t) => t.label);

/** Look up a task by label. Falls back to the first task ('Rewrite'). */
export function getTask(label: string): TextTask {
	return TASKS.find((t) => t.label === label) ?? TASKS[0] as TextTask;
}

/** System message shared by all text-transform operations. */
export const TEXT_ACTION_SYSTEM_MESSAGE =
	'You are a text editor assistant. When given text to transform, return ONLY the transformed text. ' +
	'Do not include any explanations, introductions, conclusions, or markdown code fences. ' +
	'Do not wrap the output in quotes. Return the plain transformed text directly.';
