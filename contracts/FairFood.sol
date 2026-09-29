// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

contract FairFood is ERC721, Ownable {
    struct Range {
        uint128 from;
        uint128 to;
        bytes32 ref;
    }

    struct Anchor {
        uint64 at;
        uint64 block;
    }

    mapping(bytes32 => Anchor) public anchoredAt;
    Range[] public ranges;
    mapping(uint128 => mapping(uint128 => mapping(bytes32 => bool))) public assigned;
    string private baseUri;

    event Anchored(bytes32 indexed ref, uint64 at);
    event Assigned(uint128 from, uint128 to, bytes32 indexed ref);

    constructor() ERC721("Fair Food Bag", "FFD") Ownable(msg.sender) {}

    function setBaseURI(string calldata uri) external onlyOwner {
        baseUri = uri;
    }

    function _baseURI() internal view override returns (string memory) {
        return baseUri;
    }

    function anchor(bytes32 ref) external onlyOwner {
        require(anchoredAt[ref].at == 0, "already anchored");
        anchoredAt[ref] = Anchor(uint64(block.timestamp), uint64(block.number));
        emit Anchored(ref, uint64(block.timestamp));
    }

    function assign(uint128 from, uint128 to, bytes32 ref) external onlyOwner {
        ranges.push(Range(from, to, ref));
        assigned[from][to][ref] = true;
        emit Assigned(from, to, ref);
    }

    function rangeOf(uint256 id) public view returns (Range memory) {
        for (uint256 i = ranges.length; i > 0; i--) {
            Range memory r = ranges[i - 1];
            if (id >= r.from && id <= r.to) return r;
        }
        return Range(0, 0, 0);
    }

    function recordOf(uint256 id) public view returns (bytes32) {
        return rangeOf(id).ref;
    }

    function transferBySig(uint256 id, address to, bytes calldata signature) external {
        address owner = ownerOf(id);
        bytes32 digest = keccak256(abi.encode(block.chainid, address(this), id, to));
        require(ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(digest), signature) == owner, "bad signature");
        _transfer(owner, to, id);
    }

    function transferBatch(uint256[] calldata ids, address[] calldata to) external {
        for (uint256 i = 0; i < ids.length; i++) {
            _transfer(msg.sender, to[i], ids[i]);
        }
    }

    function mint(uint256[] calldata ids, address[] calldata to) external onlyOwner {
        Range memory r = rangeOf(ids[0]);
        require(r.ref != 0, "not packed");
        for (uint256 i = 0; i < ids.length; i++) {
            require(ids[i] >= r.from && ids[i] <= r.to, "outside the run");
            _mint(to[i], ids[i]);
        }
    }
}
