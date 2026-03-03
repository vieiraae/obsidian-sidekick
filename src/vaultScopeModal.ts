import {Modal, App, TFolder, setIcon, Menu} from 'obsidian';

/**
 * Modal that displays the vault file tree with checkboxes for multi-selection.
 * Selecting a folder automatically includes all its children.
 */
export class VaultScopeModal extends Modal {
	private selected: Set<string>;
	private collapsed: Set<string>;
	private readonly onSubmit: (paths: string[]) => void;
	private searchInput!: HTMLInputElement;
	private listContainer!: HTMLElement;

	constructor(app: App, initialPaths: string[], onSubmit: (paths: string[]) => void) {
		super(app);
		this.selected = new Set(initialPaths);
		// Collapse everything except root and its direct children
		this.collapsed = new Set<string>();
		this.collapseAllBelow(this.app.vault.getRoot(), 1);
		this.onSubmit = onSubmit;

		if (initialPaths.length === 0) {
			this.selected.add('/');
		}
	}

	onOpen(): void {
		const {contentEl} = this;
		contentEl.addClass('sidekick-scope-modal');

		contentEl.createEl('h3', {text: 'Select vault scope'});

		this.searchInput = contentEl.createEl('input', {
			type: 'text',
			placeholder: 'Filter files and folders…',
			cls: 'sidekick-scope-search',
		});
		this.searchInput.addEventListener('input', () => this.renderTree());

		this.listContainer = contentEl.createDiv({cls: 'sidekick-scope-tree'});

		const btnRow = contentEl.createDiv({cls: 'sidekick-scope-buttons'});

		const clearBtn = btnRow.createEl('button', {text: 'Clear all'});
		clearBtn.addEventListener('click', () => {
			this.selected.clear();
			this.renderTree();
		});

		const okBtn = btnRow.createEl('button', {text: 'Apply', cls: 'mod-cta'});
		okBtn.addEventListener('click', () => {
			this.onSubmit(this.getTopLevelSelected());
			this.close();
		});

		const cancelBtn = btnRow.createEl('button', {text: 'Cancel'});
		cancelBtn.addEventListener('click', () => this.close());

		this.renderTree();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	// ── Tree rendering ──────────────────────────────────────────────

	private renderTree(): void {
		this.listContainer.empty();
		const filter = this.searchInput.value.toLowerCase();
		const root = this.app.vault.getRoot();

		// Render the root node
		const rootRow = this.listContainer.createDiv({cls: 'sidekick-scope-item'});

		const toggle = rootRow.createSpan({cls: 'sidekick-scope-toggle'});
		setIcon(toggle, this.collapsed.has('/') ? 'chevron-right' : 'chevron-down');
		toggle.addEventListener('click', () => {
			if (this.collapsed.has('/')) {
				this.collapsed.delete('/');
			} else {
				this.collapsed.add('/');
			}
			this.renderTree();
		});

		const checkbox = rootRow.createEl('input', {type: 'checkbox'});
		checkbox.checked = this.selected.has('/') || this.isAncestorSelected('/');

		const iconSpan = rootRow.createSpan({cls: 'sidekick-scope-icon'});
		setIcon(iconSpan, 'vault');

		rootRow.createSpan({text: this.app.vault.getName(), cls: 'sidekick-scope-name sidekick-scope-root-name'});

		// Context menu on root node
		rootRow.addEventListener('contextmenu', (e) => {
			e.preventDefault();
			this.showFolderContextMenu(e, root);
		});

		checkbox.addEventListener('change', () => {
			if (checkbox.checked) {
				this.selected.add('/');
				// Remove children — parent covers them
				this.deselectAllChildren(root);
			} else {
				this.selected.delete('/');
			}
			this.renderTree();
		});

		// Render children if not collapsed
		if (!this.collapsed.has('/')) {
			this.renderFolder(root, this.listContainer, 1, filter);
		}
	}

	private renderFolder(folder: TFolder, parent: HTMLElement, depth: number, filter: string): void {
		const sorted = [...folder.children].sort((a, b) => {
			const af = a instanceof TFolder ? 0 : 1;
			const bf = b instanceof TFolder ? 0 : 1;
			if (af !== bf) return af - bf;
			return a.name.localeCompare(b.name);
		});

		for (const child of sorted) {
			if (child.name.startsWith('.')) continue;

			const isFolder = child instanceof TFolder;
			const matchesFilter = !filter || child.path.toLowerCase().includes(filter);
			const hasMatch = isFolder && this.hasMatchingDescendants(child, filter);

			if (!matchesFilter && !hasMatch) continue;

			const row = parent.createDiv({cls: 'sidekick-scope-item'});
			row.style.paddingLeft = `${depth * 20 + 8}px`;

			if (isFolder) {
				const toggle = row.createSpan({cls: 'sidekick-scope-toggle'});
				setIcon(toggle, this.collapsed.has(child.path) ? 'chevron-right' : 'chevron-down');
				toggle.addEventListener('click', () => {
					if (this.collapsed.has(child.path)) {
						this.collapsed.delete(child.path);
					} else {
						this.collapsed.add(child.path);
					}
					this.renderTree();
				});

				// Context menu on folder rows
				row.addEventListener('contextmenu', (e) => {
					e.preventDefault();
					this.showFolderContextMenu(e, child as TFolder);
				});
			} else {
				row.createSpan({cls: 'sidekick-scope-toggle sidekick-scope-toggle-spacer'});
			}

			const checkbox = row.createEl('input', {type: 'checkbox'});
			checkbox.checked = this.selected.has(child.path) || this.isAncestorSelected(child.path);

			const iconSpan = row.createSpan({cls: 'sidekick-scope-icon'});
			setIcon(iconSpan, isFolder ? 'folder' : 'file-text');

			row.createSpan({text: child.name, cls: 'sidekick-scope-name'});

			checkbox.addEventListener('change', () => {
				if (checkbox.checked) {
					this.selected.add(child.path);
					// Remove children — parent covers them
					if (isFolder) this.deselectAllChildren(child);
				} else {
					this.selected.delete(child.path);
				}
				this.renderTree();
			});

			if (isFolder && !this.collapsed.has(child.path)) {
				this.renderFolder(child, parent, depth + 1, filter);
			}
		}
	}

	// ── Helpers ──────────────────────────────────────────────────────

	private hasMatchingDescendants(folder: TFolder, filter: string): boolean {
		if (!filter) return true;
		for (const child of folder.children) {
			if (child.path.toLowerCase().includes(filter)) return true;
			if (child instanceof TFolder && this.hasMatchingDescendants(child, filter)) return true;
		}
		return false;
	}

	private selectAllChildren(folder: TFolder): void {
		for (const child of folder.children) {
			this.selected.add(child.path);
			if (child instanceof TFolder) this.selectAllChildren(child);
		}
	}

	private deselectAllChildren(folder: TFolder): void {
		for (const child of folder.children) {
			this.selected.delete(child.path);
			if (child instanceof TFolder) this.deselectAllChildren(child);
		}
	}

	/** Check whether any ancestor path of the given path is in the selected set. */
	private isAncestorSelected(path: string): boolean {
		// Root's only ancestor concept is itself
		if (path === '/') return false;
		// Check if root is selected (covers everything)
		if (this.selected.has('/')) return true;
		// Walk up the path segments
		const parts = path.split('/');
		for (let i = 1; i < parts.length; i++) {
			const ancestor = parts.slice(0, i).join('/');
			if (this.selected.has(ancestor)) return true;
		}
		return false;
	}

	/** Return only the top-level selected paths (exclude paths whose ancestor is already selected). */
	private getTopLevelSelected(): string[] {
		const result: string[] = [];
		for (const p of this.selected) {
			if (!this.isAncestorSelected(p)) {
				result.push(p);
			}
		}
		return result;
	}

	/** Collapse all folders at depth > maxExpandedDepth (relative to vault root). */
	private collapseAllBelow(folder: TFolder, maxExpandedDepth: number, currentDepth = 0): void {
		for (const child of folder.children) {
			if (child instanceof TFolder) {
				if (currentDepth >= maxExpandedDepth) {
					this.collapsed.add(child.path);
				}
				this.collapseAllBelow(child, maxExpandedDepth, currentDepth + 1);
			}
		}
	}

	/** Expand a folder and all nested folders recursively. */
	private expandAll(folder: TFolder): void {
		const key = folder.isRoot() ? '/' : folder.path;
		this.collapsed.delete(key);
		for (const child of folder.children) {
			if (child instanceof TFolder) this.expandAll(child);
		}
	}

	/** Collapse a folder and all nested folders recursively. */
	private collapseAll(folder: TFolder): void {
		const key = folder.isRoot() ? '/' : folder.path;
		this.collapsed.add(key);
		for (const child of folder.children) {
			if (child instanceof TFolder) this.collapseAll(child);
		}
	}

	/** Show a context menu on a folder node with expand/collapse options. */
	private showFolderContextMenu(evt: MouseEvent, folder: TFolder): void {
		const menu = new Menu();
		menu.addItem(item =>
			item.setTitle('Expand all')
				.setIcon('chevrons-down-up')
				.onClick(() => {
					this.expandAll(folder);
					this.renderTree();
				})
		);
		menu.addItem(item =>
			item.setTitle('Collapse all')
				.setIcon('chevrons-up-down')
				.onClick(() => {
					this.collapseAll(folder);
					this.renderTree();
				})
		);
		menu.showAtMouseEvent(evt);
	}
}
