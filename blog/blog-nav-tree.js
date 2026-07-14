/* ============================================================
   BLOG NAV TREE — blog-nav-tree.js
   Self-contained left sidebar that maps every blog post into a
   tree based on which post's call-to-action links to which.
   Include on every /blog/* page with:
   <script src="/blog/blog-nav-tree.js" defer></script>
   ============================================================ */
(function () {

  // Tree shape: A -> [B, C] means B and C are linked from A's
  // call-to-action / body, so they render nested under A.
  // A node's parent is whichever post's CTA first pointed to it;
  // when more than one post links to the same node, the Start Here
  // hub (or the earliest-linking post) wins so the tree stays a
  // clean single hierarchy instead of duplicating nodes.
  // Every post on the site is a descendant of the single root below.
  // noToggle: true means the node has no collapse control of its own —
  // its children always render, so descendants can never be hidden.
  var TREE = [
    {
      slug: 'stem-humanities-bridge',
      title: 'The Missing Language',
      noToggle: true,
      defaultOpen: true,
      children: [
        {
          slug: 'be-the-bridge-stem-thinker',
          title: 'The STEM Thinker',
          defaultOpen: true,
          children: [
            {
              folder: true, slug: '__folder-literature', title: 'Literature',
              children: [
                { slug: 'what-is-worth-sharing', title: 'What Is Worth Sharing?', children: [] },
                { slug: 'shape-of-a-developed-idea', title: 'The Shape of a Developed Idea', children: [] },
                { slug: 'heart-of-a-teacher', title: 'The Heart of a Teacher', children: [] },
                { slug: 'motivation-is-the-hard-part', title: 'Motivation Is the Hard Part', children: [] }
              ]
            },
            {
              folder: true, slug: '__folder-philosophy', title: 'Philosophy',
              children: [
                { slug: 'improving-spocks-eq', title: "Improving Spock's EQ", children: [] },
                { slug: 'logic-of-problem-and-person', title: 'The Logic of a Problem, the Logic of a Person', children: [] },
                { slug: 'people-process-tools', title: 'People, Process & Tools', children: [] },
                { slug: 'how-to-run-a-culture-audit-workshop', title: 'Culture Audit Workshop', children: [] },
                { slug: 'agents-components-interactions', title: 'Every System Has the Same Shape', children: [] }
              ]
            },
            {
              folder: true, slug: '__folder-history', title: 'History',
              children: [
                { slug: 'understand-the-past', title: 'Start With the History', children: [] },
                { slug: 'principles-over-headlines', title: 'The Principles Rarely Do', children: [] }
              ]
            },
            {
              folder: true, slug: '__folder-rhetoric', title: 'Rhetoric',
              children: [
                { slug: 'your-first-industry-conference-talk', title: 'Your First Conference Talk', children: [] },
                { slug: 'communication-skills-workshop-for-technical-teams', title: 'Communication Skills Workshop', children: [] },
                { slug: 'influence-and-authority', title: 'Authority vs. Influence', children: [] }
              ]
            }
          ]
        },
        {
          slug: 'be-the-bridge-humanities-thinker',
          title: 'The Humanities Thinker',
          defaultOpen: true,
          children: [
            {
              folder: true, slug: '__folder-ai', title: 'AI',
              children: [
                { slug: 'ai-security-workshop', title: 'AI Security Workshop Guide', children: [] },
                { slug: 'how-to-facilitate-an-ai-literacy-workshop', title: 'AI Literacy Workshop Guide', children: [] },
                { slug: 'principles-of-ai-data-science', title: 'Principles of AI & Data Science', children: [] }
              ]
            },
            {
              folder: true, slug: '__folder-cybersecurity', title: 'Cybersecurity',
              children: [
                { slug: 'cybersecurity-awareness-workshop', title: 'Cybersecurity Awareness Workshop', children: [] },
                { slug: 'cybersecurity-mindset-critical-thinking', title: 'Cybersecurity Mindset', children: [] }
              ]
            },
            {
              folder: true, slug: '__folder-quantum-computing', title: 'Quantum Computing',
              children: [
                { slug: 'quantum-computing-basics', title: 'Quantum Computing Basics', children: [] }
              ]
            }
          ]
        }
      ]
    }
  ];

  function currentSlug() {
    var m = window.location.pathname.match(/\/blog\/([^/?#]+)/);
    if (!m) return null;
    return m[1].replace(/\.html?$/i, '');
  }

  // Path of slugs from root to the current page, so we can force
  // that branch open even though everything else starts collapsed.
  function findPath(nodes, slug, trail) {
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var next = trail.concat([node.slug]);
      if (node.slug === slug) return next;
      var found = findPath(node.children, slug, next);
      if (found) return found;
    }
    return null;
  }

  var NAV_WIDTH = 270;

  function injectStyles() {
    var css = ''
      + '.blog-tree-nav{position:fixed;top:0;left:0;width:' + NAV_WIDTH + 'px;max-width:85vw;height:100vh;overflow-y:auto;'
      + 'background:#fff;border-right:2px solid #dde8c8;padding:18px 14px 40px;z-index:90;'
      + 'font-family:"Nunito","Segoe UI",system-ui,sans-serif;box-sizing:border-box;'
      + 'transform:translateX(-100%);transition:transform 0.2s ease;box-shadow:0 0 24px rgba(0,0,0,0.15);}'
      + '.blog-tree-nav.open{transform:translateX(0);}'
      + '.blog-tree-nav-title-row{display:flex;align-items:center;justify-content:space-between;'
      + 'padding:0 4px 8px 8px;border-bottom:2px solid #f0f5e4;}'
      + '.blog-tree-nav-title-group{display:flex;align-items:center;gap:8px;}'
      + '.blog-tree-nav-title{font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:0.08em;'
      + 'color:#4a8c11;}'
      + '.blog-tree-home-btn{display:flex;align-items:center;justify-content:center;width:22px;height:22px;'
      + 'flex-shrink:0;border-radius:6px;color:#4a8c11;background:#f4fae8;border:1px solid #dde8c8;'
      + 'text-decoration:none;transition:background 0.15s,color 0.15s;}'
      + '.blog-tree-home-btn:hover{background:#62b517;color:#fff;}'
      + '.blog-tree-close-btn{background:none;border:none;color:#8a9a6a;font-size:15px;font-weight:900;'
      + 'cursor:pointer;padding:2px 6px;flex-shrink:0;display:none;line-height:1;}'
      + '.blog-tree-close-btn:hover{color:#4a8c11;}'
      + '.blog-tree-controls{display:flex;gap:6px;padding:8px 8px 12px;}'
      + '.blog-tree-control-btn{flex:1;font-size:10.5px;font-weight:800;color:#4a8c11;background:#f4fae8;'
      + 'border:1px solid #dde8c8;border-radius:6px;padding:5px 4px;cursor:pointer;transition:background 0.15s;}'
      + '.blog-tree-control-btn:hover{background:#eaf5d8;}'
      + '.blog-tree-root{list-style:none;margin:0;padding:0;}'
      + '.blog-tree-root ul{list-style:none;margin:2px 0 4px 14px;padding:0 0 0 10px;border-left:2px solid #eef3e0;}'
      + '.blog-tree-node{margin:1px 0;}'
      + '.blog-tree-row{display:flex;align-items:center;gap:4px;}'
      + '.blog-tree-toggle{background:none;border:none;cursor:pointer;color:#8a9a6a;font-size:10px;'
      + 'width:16px;height:24px;flex-shrink:0;transition:transform 0.15s;padding:0;}'
      + '.blog-tree-toggle.open{transform:rotate(90deg);}'
      + '.blog-tree-spacer{width:16px;flex-shrink:0;}'
      + '.blog-tree-link{display:flex;align-items:center;gap:6px;flex:1;font-size:12.5px;font-weight:700;'
      + 'color:#4a5a3a;text-decoration:none;padding:5px 6px;border-radius:6px;line-height:1.3;}'
      + '.blog-tree-link:hover{background:#f4fae8;color:#4a8c11;}'
      + '.blog-tree-link.active{background:#eaf5d8;color:#2a6a0a;font-weight:900;}'
      + '.blog-tree-folder-label{display:flex;align-items:center;flex:1;font-size:10.5px;font-weight:900;'
      + 'text-transform:uppercase;letter-spacing:0.06em;color:#8a9a6a;padding:5px 6px;}'
      + '.blog-tree-children{display:none;}'
      + '.blog-tree-children.open{display:block;}'
      + '.blog-tree-children.blog-tree-locked-open{display:block!important;}'
      + '.blog-tree-toggle-btn{position:absolute;left:14px;z-index:90;margin:0;'
      + 'background:#62b517;color:#fff;border:none;border-radius:8px;padding:8px 12px;font-weight:900;'
      + 'font-size:12px;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,0.2);}'
      + '.blog-tree-backdrop{position:fixed;inset:0;background:rgba(20,30,15,0.35);z-index:89;'
      + 'display:none;}'
      + '.blog-tree-backdrop.open{display:block;}';
    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  function buildList(nodes, openPath, active) {
    var ul = document.createElement('ul');
    ul.className = 'blog-tree-root';
    nodes.forEach(function (node) {
      ul.appendChild(buildNode(node, openPath, active));
    });
    return ul;
  }

  function buildNode(node, openPath, active) {
    var li = document.createElement('li');
    li.className = 'blog-tree-node';

    var row = document.createElement('div');
    row.className = 'blog-tree-row';

    var hasChildren = node.children && node.children.length > 0;
    var onPath = openPath.indexOf(node.slug) !== -1;
    var isOpen = onPath || !!node.defaultOpen || !!node.noToggle;
    var defaultCls = node.defaultOpen ? ' blog-tree-default' : '';

    if (hasChildren && !node.noToggle) {
      var toggle = document.createElement('button');
      toggle.className = 'blog-tree-toggle' + defaultCls + (isOpen ? ' open' : '');
      toggle.setAttribute('aria-label', 'Toggle section');
      toggle.textContent = '▶';
      row.appendChild(toggle);
    } else {
      var spacer = document.createElement('span');
      spacer.className = 'blog-tree-spacer';
      row.appendChild(spacer);
    }

    if (node.folder) {
      var label = document.createElement('span');
      label.className = 'blog-tree-folder-label';
      label.appendChild(document.createTextNode(node.title));
      row.appendChild(label);
    } else {
      var a = document.createElement('a');
      a.className = 'blog-tree-link' + (node.slug === active ? ' active' : '');
      a.href = '/blog/' + node.slug;
      a.appendChild(document.createTextNode(node.title));
      row.appendChild(a);
    }
    li.appendChild(row);

    if (hasChildren) {
      var childWrap = document.createElement('div');
      childWrap.className = 'blog-tree-children' + defaultCls + (isOpen ? ' open' : '') +
        (node.noToggle ? ' blog-tree-locked-open' : '');
      childWrap.appendChild(buildList(node.children, openPath, active));
      li.appendChild(childWrap);

      if (!node.noToggle) {
        row.querySelector('.blog-tree-toggle').addEventListener('click', function () {
          var t = row.querySelector('.blog-tree-toggle');
          t.classList.toggle('open');
          childWrap.classList.toggle('open');
        });
      }
    }

    return li;
  }

  function setAllOpen(aside, open) {
    aside.querySelectorAll('.blog-tree-toggle').forEach(function (t) {
      t.classList.toggle('open', open);
    });
    aside.querySelectorAll('.blog-tree-children').forEach(function (c) {
      c.classList.toggle('open', open);
    });
  }

  // "Collapse All" doesn't fully close the tree, it resets back to the
  // default view: just the root open enough to show the Start Here posts.
  function resetToDefault(aside) {
    setAllOpen(aside, false);
    aside.querySelectorAll('.blog-tree-default').forEach(function (el) {
      el.classList.add('open');
    });
  }

  function init() {
    injectStyles();

    var active = currentSlug();
    var openPath = findPath(TREE, active, []) || [];

    var aside = document.createElement('aside');
    aside.className = 'blog-tree-nav';
    aside.setAttribute('aria-label', 'Blog post map');

    var titleRow = document.createElement('div');
    titleRow.className = 'blog-tree-nav-title-row';

    var titleGroup = document.createElement('div');
    titleGroup.className = 'blog-tree-nav-title-group';

    var homeBtn = document.createElement('a');
    homeBtn.className = 'blog-tree-home-btn';
    homeBtn.href = '/blog';
    homeBtn.setAttribute('aria-label', 'Back to blog home');
    homeBtn.title = 'Back to blog home';
    homeBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9a1 1 0 0 0 1 1H9a1 1 0 0 0 1-1v-4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v4a1 1 0 0 0 1 1h2.5a1 1 0 0 0 1-1v-9"/></svg>';
    titleGroup.appendChild(homeBtn);

    var title = document.createElement('div');
    title.className = 'blog-tree-nav-title';
    title.textContent = 'Explore the Blog';
    titleGroup.appendChild(title);

    titleRow.appendChild(titleGroup);

    var closeBtn = document.createElement('button');
    closeBtn.className = 'blog-tree-close-btn';
    closeBtn.textContent = '✕';
    closeBtn.setAttribute('aria-label', 'Close blog map');
    titleRow.appendChild(closeBtn);

    aside.appendChild(titleRow);

    var controls = document.createElement('div');
    controls.className = 'blog-tree-controls';

    var expandBtn = document.createElement('button');
    expandBtn.className = 'blog-tree-control-btn';
    expandBtn.textContent = 'Expand All';
    expandBtn.addEventListener('click', function () {
      setAllOpen(aside, true);
    });

    var collapseBtn = document.createElement('button');
    collapseBtn.className = 'blog-tree-control-btn';
    collapseBtn.textContent = 'Collapse All';
    collapseBtn.addEventListener('click', function () {
      resetToDefault(aside);
    });

    controls.appendChild(expandBtn);
    controls.appendChild(collapseBtn);
    aside.appendChild(controls);

    aside.appendChild(buildList(TREE, openPath, active));

    var backdrop = document.createElement('div');
    backdrop.className = 'blog-tree-backdrop';

    var toggleBtn = document.createElement('button');
    toggleBtn.className = 'blog-tree-toggle-btn';
    toggleBtn.textContent = '☰ Blog Map';

    // Identical look and mechanism at every screen size: an overlay panel
    // with a backdrop, opened by the floating button and closed by the
    // in-panel ✕ or a backdrop tap. Never touches page layout or the
    // header, which stays exactly where it is regardless of nav state.
    // The only thing that differs by size is the default open/closed state.
    function setOpen(open) {
      aside.classList.toggle('open', open);
      toggleBtn.style.display = open ? 'none' : 'block';
      closeBtn.style.display = open ? 'flex' : 'none';
      backdrop.classList.toggle('open', open);
    }

    toggleBtn.addEventListener('click', function () {
      setOpen(!aside.classList.contains('open'));
    });
    closeBtn.addEventListener('click', function () {
      setOpen(false);
    });
    backdrop.addEventListener('click', function () {
      setOpen(false);
    });

    function positionBelowHeader() {
      var header = document.querySelector('header');
      var h = header ? Math.round(header.getBoundingClientRect().height) : 68;
      aside.style.top = h + 'px';
      aside.style.height = 'calc(100vh - ' + h + 'px)';
      // Absolutely positioned (not fixed), so it sits at a set spot on the
      // page just below the header without pushing any content down, and
      // scrolls away with the page instead of floating on top of it.
      toggleBtn.style.top = (h + 10) + 'px';
    }

    window.addEventListener('resize', positionBelowHeader);

    var header = document.querySelector('header');
    document.body.insertBefore(aside, document.body.firstChild);
    aside.insertAdjacentElement('afterend', backdrop);
    if (header) {
      header.insertAdjacentElement('afterend', toggleBtn);
    } else {
      backdrop.insertAdjacentElement('afterend', toggleBtn);
    }

    positionBelowHeader();
    setOpen(false);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
