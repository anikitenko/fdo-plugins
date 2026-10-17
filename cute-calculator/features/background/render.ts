/**
 * Decorative, self-contained artwork. Layout styles can position the
 * rose-cat-background layer; the illustration never receives input or focus.
 */
export function renderCatBackground(): string {
  return `
    <div
      class="rose-background rose-cat-background"
      data-cat-background
      aria-hidden="true"
      inert
      style="position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:0;"
    >
      <svg
        class="rose-cat-background__art"
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 1440 1000"
        preserveAspectRatio="xMidYMid slice"
        aria-hidden="true"
        focusable="false"
        data-cat-artwork
        style="display:block;pointer-events:none;"
      >
        <!-- Broad, quiet color layers frame the foreground surfaces. -->
        <ellipse
          cx="300" cy="370" rx="490" ry="440"
          fill="var(--rose-cat-halo, #efd0dc)" opacity=".42"
        />
        <ellipse
          cx="1270" cy="790" rx="400" ry="330"
          fill="var(--rose-cat-shadow, #79516f)" opacity=".12"
        />
        <ellipse
          cx="710" cy="960" rx="620" ry="110"
          fill="var(--rose-cat-shadow, #79516f)" opacity=".14"
        />

        <!-- A curling tail extends around the right side of the panels. -->
        <path
          d="M930 849
             C1110 940 1396 878 1364 659
             C1347 543 1246 509 1195 576
             C1154 630 1202 705 1255 675"
          fill="none"
          stroke="var(--rose-cat-outline, #88556f)"
          stroke-width="100"
          stroke-linecap="round"
          opacity=".48"
        />
        <path
          d="M930 849
             C1110 940 1396 878 1364 659
             C1347 543 1246 509 1195 576
             C1154 630 1202 705 1255 675"
          fill="none"
          stroke="var(--rose-cat-fur, #dba3b9)"
          stroke-width="76"
          stroke-linecap="round"
        />

        <!-- Rounded body and oversized paws remain visible below the cards. -->
        <path
          d="M339 508
             C287 578 240 699 263 825
             C283 938 427 984 681 980
             C890 977 1027 921 1008 807
             C990 698 873 571 724 522 Z"
          fill="var(--rose-cat-fur, #dba3b9)"
          stroke="var(--rose-cat-outline, #88556f)"
          stroke-width="9"
          stroke-linejoin="round"
        />
        <ellipse
          cx="590" cy="810" rx="220" ry="161"
          fill="var(--rose-cat-light, #f4dce5)" opacity=".7"
        />
        <g
          fill="var(--rose-cat-light, #f4dce5)"
          stroke="var(--rose-cat-outline, #88556f)"
          stroke-width="7"
          stroke-linecap="round"
        >
          <path d="M288 852 C239 860 210 920 247 947 C285 978 408 973 431 942 C456 905 394 850 350 851 Z" />
          <path d="M751 862 C696 878 678 930 716 955 C765 983 886 977 907 939 C927 900 852 852 806 854 Z" />
          <path d="M289 925 L289 946 M325 926 L325 949 M761 933 L761 956 M798 935 L798 958" fill="none" />
        </g>

        <!-- Tall triangular ears and a broad cheek silhouette define the cat. -->
        <path
          d="M133 319
             L110 72
             Q108 48 132 60
             L319 173
             Q405 138 488 178
             L662 61
             Q686 44 684 76
             L667 325
             Q729 400 692 494
             Q657 591 522 615
             Q345 651 199 573
             Q78 509 104 406
             Q111 357 133 319 Z"
          fill="var(--rose-cat-fur, #dba3b9)"
          stroke="var(--rose-cat-outline, #88556f)"
          stroke-width="9"
          stroke-linejoin="round"
        />
        <path
          d="M146 102 L169 287 L279 193 Z
             M647 104 L528 194 L629 292 Z"
          fill="var(--rose-cat-ear, #af6587)" opacity=".72"
        />
        <path
          d="M159 121 L177 229 L235 192 Z
             M633 125 L567 194 L619 231 Z"
          fill="var(--rose-cat-light, #f4dce5)" opacity=".5"
        />

        <!-- Forehead markings, sleepy eyes, nose, muzzle and long whiskers. -->
        <g
          fill="none"
          stroke="var(--rose-cat-outline, #88556f)"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path
            d="M351 180 L369 235 M398 175 L399 226 M445 186 L430 237"
            stroke-width="18" opacity=".38"
          />
          <path
            d="M188 361 Q233 321 278 360
               M477 359 Q523 319 568 358"
            stroke-width="13"
          />
          <path
            d="M194 359 L181 345 M561 357 L574 342"
            stroke-width="8"
          />
        </g>
        <ellipse
          cx="220" cy="405" rx="49" ry="25"
          fill="var(--rose-cat-ear, #af6587)" opacity=".32"
        />
        <ellipse
          cx="540" cy="405" rx="49" ry="25"
          fill="var(--rose-cat-ear, #af6587)" opacity=".32"
        />
        <path
          d="M300 402
             Q346 375 384 404
             Q424 376 469 405
             Q499 447 461 482
             Q419 511 384 479
             Q343 511 306 484
             Q270 454 300 402 Z"
          fill="var(--rose-cat-light, #f4dce5)"
        />
        <path
          d="M362 406 Q384 396 406 406 L386 429 Q383 432 380 428 Z"
          fill="var(--rose-cat-outline, #88556f)"
        />
        <g
          fill="none"
          stroke="var(--rose-cat-outline, #88556f)"
          stroke-width="7"
          stroke-linecap="round"
        >
          <path d="M384 429 L384 450 Q365 474 343 451 M384 450 Q403 475 425 451" />
          <path
            d="M269 423 L79 392
               M265 450 L58 454
               M274 477 L92 523
               M496 423 L700 393
               M501 450 L722 458
               M492 478 L697 531"
            opacity=".64"
          />
        </g>

        <!-- Small botanical accents echo the rose palette without animation. -->
        <g
          fill="var(--rose-cat-ear, #af6587)"
          opacity=".28"
        >
          <path d="M1110 122 C1078 77 1027 106 1045 143 C1060 167 1090 181 1110 200 C1130 179 1163 165 1174 140 C1189 101 1139 80 1110 122 Z" />
          <path d="M83 724 C65 699 35 717 45 738 C54 752 71 762 83 772 C96 759 114 752 120 736 C128 714 100 700 83 724 Z" />
        </g>
        <g
          fill="none"
          stroke="var(--rose-cat-outline, #88556f)"
          stroke-width="5"
          stroke-linecap="round"
          opacity=".23"
        >
          <path d="M1262 232 L1262 268 M1244 250 L1280 250" />
          <path d="M78 612 L78 640 M64 626 L92 626" />
          <path d="M1021 79 L1021 101 M1010 90 L1032 90" />
        </g>
      </svg>
    </div>
  `;
}